// db.js — Pool PostgreSQL (Supabase)
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // requis pour Supabase
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

// Helper : exécuter une requête simple
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Helper : récupérer une seule ligne
async function getOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

// Helper : récupérer toutes les lignes
async function getAll(text, params) {
  const res = await query(text, params);
  return res.rows;
}

// Helper : insérer et retourner l'id
async function insert(text, params) {
  const res = await query(text + " RETURNING id", params);
  return res.rows[0]?.id;
}

module.exports = { pool, query, getOne, getAll, insert };
