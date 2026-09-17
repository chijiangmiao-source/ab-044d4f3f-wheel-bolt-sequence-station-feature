import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://hub:hub@localhost:5432/hub_review',
  max: 10,
});
