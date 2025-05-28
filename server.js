const express = require("express");
const http = require('http');
const cors = require('cors');
const zlib = require('zlib');
const {Pool} = require('pg');
const proj4  = require('proj4')
const tilebelt = require('@mapbox/tilebelt');
const webSocket = require('ws');
// const { getTileFromCache, storeTileToCache,deleteTile } = require('./tileCache');
const wss = new webSocket.Server({noServer:true});
const Clients = new Set();

const app = express()
app.use(cors())
app.use(express.json());
const server = http.createServer(app);
const tableNames = ["can_master_04042025","manhole"];

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'postgis_35_sample',
  password: 'GisCell@123',
  port: 5432,
  max:20
});
// let table_Fields = '*'; // fallback

wss.on("connection", (ws) => {
  Clients.add(ws);
  console.log("New client connected. Total clients:", Clients.size);

  ws.on("close", () => {
    Clients.delete(ws);
    console.log("Client disconnected. Remaining clients:", Clients.size);
  });
});
var  table_Fields = {};
async function initializeFieldList() {
  try {
    for(var table of tableNames){
const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = $1 
    `, [table]);

    const columnNames = result.rows.map(r => r.column_name);
    
    // Identify geometry column
    const geomColumn = columnNames.includes('geom') ? 'geom' :
                       columnNames.includes('shape') ? 'shape' : null;

    if (!geomColumn) {
      throw new Error(`No geometry column ('geom' or 'shape') found in table ${tableNames[0]}`);
    }

    // Store non-geometry fields
     table_Fields[table] = columnNames
      .filter(col => col !== geomColumn)
      .map(col => `t.${col}`)
      .join(', ');

    // Also store geom column name separately if needed
    table_Fields[`${table}_geom`] = geomColumn;
    }

  } catch (err) {
    console.error("Error fetching column names:", err);
  }
}

app.get('/tiles/:z/:x/:y.mvt', async (req, res) => {
  const { z, x, y } = req.params;
  const maxAllowedZoom = 20;
  let queries = [];
  if (+z > maxAllowedZoom) {
    console.warn(`Blocked request at zoom ${z}, exceeds max allowed ${maxAllowedZoom}`);
    return res.status(400).send(`Zoom level ${z} is not supported`);
  }
  // const cachedTile = getTileFromCache(z, x, y);
  // if (cachedTile) {
  //   res.setHeader('Content-Type', 'application/x-protobuf');
  //    res.setHeader('Cache-Control', 'public, max-age=3600');
  //   res.setHeader('Content-Encoding', 'gzip');
  //   return res.send(cachedTile);
  // }
  const [minLng, minLat, maxLng, maxLat] = tilebelt.tileToBBOX([+x, +y, +z]);
   const bbox = convertToWebMercator(minLng, minLat, maxLng, maxLat);
   const sql = returnQuery(
  tableNames[0],
  table_Fields[tableNames[0]],
  table_Fields[`${tableNames[0]}_geom`]
);

  //  console.log("sql :",sql)
//const sql = queries.join(' UNION ALL ');
  try {
    const result = await pool.query(sql, [...bbox, +z]);
    const tile = result.rows[0].tile;
    const count = result.rows[0].cnt;
    if (!tile || tile.length === 0) {
      return res.status(204).send(); // No content
    }

    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('X-Feature-Count', count);

    zlib.gzip(tile, (err, compressedTile) => {
      if (err) return res.status(500).send('Compression failed');
      //storeTileToCache(z, x, y, compressedTile);
      res.setHeader('Content-Type', 'application/x-protobuf');
      res.setHeader('Content-Encoding', 'gzip');
      res.send(compressedTile);
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating tile");
  }
});

function convertToWebMercator(minLng, minLat, maxLng, maxLat) {
  const wm = proj4('EPSG:4326', 'EPSG:3857');
  const [x1, y1] = wm.forward([minLng, minLat]);
  const [x2, y2] = wm.forward([maxLng, maxLat]);
  return [x1, y1, x2, y2];
}
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
function returnQuery(tbName, fields, geomColumn) {
  try {
    if (!geomColumn) {
      throw new Error(`No known geometry field ('geom' or 'shape') found for table: ${tbName}`);
    }

    const sql = `
      WITH
      bounds AS (
        SELECT ST_MakeEnvelope($1, $2, $3, $4, 3857) AS ${geomColumn}
      ),
      features AS (
        SELECT
          ST_AsMVTGeom(
            ST_SimplifyPreserveTopology(
              t.${geomColumn},
              CASE
                WHEN $5 < 8 THEN 100
                WHEN $5 < 12 THEN 300
                ELSE 500
              END
            ),
            bounds.${geomColumn}
          ) AS ${geomColumn},
           '${tbName}' AS table_name,
         ${fields}
        FROM ${tbName} t, bounds
        WHERE ST_SRID(t.${geomColumn}) = 3857
          AND ST_IsValid(t.${geomColumn})
          AND ST_Intersects(t.${geomColumn}, bounds.${geomColumn})
      ),
      features_filtered AS (
        SELECT * FROM features WHERE ${geomColumn} IS NOT NULL
        LIMIT CASE
          WHEN $5 < 8 THEN 200
          WHEN $5 < 12 THEN 500
          ELSE 1000
        END
      ),
      count_cte AS (
        SELECT COUNT(*) AS cnt FROM features_filtered
      )
      SELECT
        (SELECT ST_AsMVT(features_filtered.*,'${tbName}', 4096, '${geomColumn}') FROM features_filtered) AS tile,
        cnt
      FROM count_cte;
    `;

    return sql;
  } catch (error) {
    console.log("Error occurred while generating query:", error.message);
  }
}

initializeFieldList().then(()=>{
  server.listen(3000,()=>{
    console.log("server running at port 3000")
})
})
app.post('/update', async (req, res) => {
    const featureData = req.body;
    const objectid = featureData.objectid;
    const table_name = featureData.tableName;
    const zoom = featureData.zoomLevel;  // Zoom level from clien
    if (!objectid) {
      return res.status(400).json({ error: "Missing objectid" });
    }

    try {
      // Build dynamic SET clause, excluding 'objectid' and 'zoomLevel'
      const fields = Object.entries(featureData)
        .filter(([key]) => key !== 'objectid'&& key !== "zoomLevel" && key !== 'tableName')  // Exclude zoomLevel
        .map(([key], index) => `${key} = $${index + 1}`);

      const values = Object.entries(featureData)
        .filter(([key]) => key !== 'objectid'&& key !== "zoomLevel" && key !== 'tableName')  // Exclude zoomLevel
        .map(([, value]) => value);

      if (fields.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }
      const geomColumn = await getGeometryColumn(table_name);
      const geojsonSelect = geomColumn ? `, ST_AsGeoJSON(${geomColumn}) AS geojson` : '';

      //here we need to do modification
      // Dynamic SQL query
      const query = `
        UPDATE ${table_name}
        SET ${fields.join(', ')}
        WHERE objectid = $${fields.length + 1}
        RETURNING *${geojsonSelect}
      `;
  
      values.push(objectid);  // Add objectid for WHERE clause

      // Execute the query
      const result = await pool.query(query, values);
      const updatedFeature = result.rows[0];
      const geojson = JSON.parse(updatedFeature.geojson);
          if (
        geojson.type !== "MultiPoint" ||
        !Array.isArray(geojson.coordinates) ||
        geojson.coordinates.length === 0
      ) {
        return res.status(400).json({ error: "Invalid or empty geometry" });
      }

      //const [lng, lat] = geojson.coordinates[0]; // ✅ Extract from first point
      const [x3857, y3857] = geojson.coordinates[0];
      const [lng, lat] = proj4('EPSG:3857', 'EPSG:4326', [x3857, y3857]);
      if (isNaN(lng) || isNaN(lat)) {
        return res.status(400).json({ error: "Invalid coordinates" });
      }
        const tile = tilebelt.pointToTile(lng, lat, zoom);
        deleteTile(tile[2], tile[0], tile[1]);
       const tileInfo = {
            type: 'tile-update',
            tile: {
              z: tile[2],
              x: tile[0],
              y: tile[1]
            }
          };
        Clients.forEach((client) => {
        if (client.readyState === webSocket.OPEN) {
          client.send(JSON.stringify(tileInfo));
        }
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Feature not found" });
      }


      // Return the updated feature in the response
      res.status(200).json({ feature: updatedFeature, message: "Feature updated successfully" });
  
    } catch (error) {
      console.error("Update error:", error);
      res.status(500).json({ error: "Database update failed" });
    }
});

async function getGeometryColumn(tableName) {
  const geomColQuery = `
    SELECT f_geometry_column
    FROM geometry_columns
    WHERE f_table_name = $1
    LIMIT 1
  `;
  const result = await pool.query(geomColQuery, [tableName]);
  return result.rows[0]?.f_geometry_column || null;
}


