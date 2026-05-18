import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host:               process.env.DATABASE_HOST,
  port:               parseInt(process.env.DATABASE_PORT || '25060'),
  user:               process.env.DATABASE_USERNAME,
  password:           process.env.DATABASE_PASSWORD,
  database:           process.env.DATABASE_NAME,
  ssl:                { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    5,
  connectTimeout:     10000,
});

export default pool;
