// scripts/migrate.js — Création des tables PostgreSQL (Supabase)
const { pool } = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Migration PostgreSQL...');

    await client.query(`
      -- USERS
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT UNIQUE NOT NULL,
        password   TEXT NOT NULL,
        role       TEXT DEFAULT 'Membre',
        avatar     TEXT DEFAULT '',
        is_admin   BOOLEAN DEFAULT FALSE,
        titulaire  BOOLEAN DEFAULT TRUE,
        pending    BOOLEAN DEFAULT TRUE,
        theme      TEXT DEFAULT 'Cosmos',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- CHANNELS
      CREATE TABLE IF NOT EXISTS channels (
        id          SERIAL PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO channels (name, description)
        VALUES ('general', 'Canal général')
        ON CONFLICT (name) DO NOTHING;

      -- MESSAGES
      CREATE TABLE IF NOT EXISTS messages (
        id         SERIAL PRIMARY KEY,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id),
        text       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- NOTE_THEMES
      CREATE TABLE IF NOT EXISTS note_themes (
        id         SERIAL PRIMARY KEY,
        name       TEXT UNIQUE NOT NULL,
        color      TEXT DEFAULT '#4f7cff',
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO note_themes (name, color) VALUES ('RH', '#4f7cff')         ON CONFLICT (name) DO NOTHING;
      INSERT INTO note_themes (name, color) VALUES ('Activités', '#3ecf8e')   ON CONFLICT (name) DO NOTHING;
      INSERT INTO note_themes (name, color) VALUES ('Conditions', '#f5a623')  ON CONFLICT (name) DO NOTHING;

      -- NOTES
      CREATE TABLE IF NOT EXISTS notes (
        id         SERIAL PRIMARY KEY,
        title      TEXT NOT NULL,
        content    TEXT DEFAULT '',
        status     TEXT DEFAULT 'proposition',
        theme      TEXT DEFAULT '',
        author_id  INTEGER REFERENCES users(id),
        meeting_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- MEETINGS
      CREATE TABLE IF NOT EXISTS meetings (
        id         SERIAL PRIMARY KEY,
        title      TEXT NOT NULL,
        date       TEXT NOT NULL,
        time       TEXT NOT NULL,
        location   TEXT DEFAULT '',
        status     TEXT DEFAULT 'upcoming',
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- AGENDA_ITEMS
      CREATE TABLE IF NOT EXISTS agenda_items (
        id         SERIAL PRIMARY KEY,
        meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
        content    TEXT NOT NULL,
        position   INTEGER DEFAULT 0
      );

      -- MEETING_ATTENDEES
      CREATE TABLE IF NOT EXISTS meeting_attendees (
        meeting_id     INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
        user_id        INTEGER REFERENCES users(id),
        status         TEXT DEFAULT 'pending',
        replacement_id INTEGER REFERENCES users(id),
        PRIMARY KEY (meeting_id, user_id)
      );

      -- DOCUMENTS
      CREATE TABLE IF NOT EXISTS documents (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        filename    TEXT NOT NULL,
        size        INTEGER DEFAULT 0,
        category    TEXT DEFAULT 'Divers',
        icon        TEXT DEFAULT '📄',
        uploaded_by INTEGER REFERENCES users(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- DELEGATION_CONFIG
      CREATE TABLE IF NOT EXISTS delegation_config (
        id              INTEGER PRIMARY KEY DEFAULT 1,
        hours_titulaire REAL DEFAULT 20,
        hours_suppleant REAL DEFAULT 7,
        max_report      REAL DEFAULT 30,
        start_year      INTEGER DEFAULT 0,
        start_month     INTEGER DEFAULT 0,
        rh_email        TEXT DEFAULT '',
        smtp_host       TEXT DEFAULT '',
        smtp_port       INTEGER DEFAULT 587,
        smtp_user       TEXT DEFAULT '',
        smtp_pass       TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO delegation_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

      -- DELEGATION_ENTRIES
      CREATE TABLE IF NOT EXISTS delegation_entries (
        id          SERIAL PRIMARY KEY,
        taker_id    INTEGER NOT NULL REFERENCES users(id),
        owner_id    INTEGER REFERENCES users(id),
        is_pool     BOOLEAN DEFAULT FALSE,
        hours       REAL NOT NULL,
        date        TEXT NOT NULL,
        description TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- DELEGATION_TRANSFERS
      CREATE TABLE IF NOT EXISTS delegation_transfers (
        id         SERIAL PRIMARY KEY,
        from_id    INTEGER NOT NULL REFERENCES users(id),
        to_id      INTEGER NOT NULL REFERENCES users(id),
        hours      REAL NOT NULL,
        date       TEXT NOT NULL,
        note       TEXT,
        status     TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- NOTIFICATIONS
      CREATE TABLE IF NOT EXISTS notifications (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        body       TEXT,
        type       TEXT DEFAULT 'info',
        read       BOOLEAN DEFAULT FALSE,
        link       TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- PUSH_SUBSCRIPTIONS
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth_key   TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- PUSH_CONFIG
      CREATE TABLE IF NOT EXISTS push_config (
        id            INTEGER PRIMARY KEY DEFAULT 1,
        vapid_public  TEXT,
        vapid_private TEXT,
        vapid_email   TEXT DEFAULT 'contact@cse.fr'
      );
      INSERT INTO push_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);

    console.log('✅ Tables créées / vérifiées');
    console.log('✅ Migration terminée !');
  } catch (e) {
    console.error('❌ Erreur migration:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
