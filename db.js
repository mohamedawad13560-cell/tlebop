// طبقة قاعدة البيانات (MySQL) لبوت قسم التحقيق (محدثة بالكامل)
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "investigation",
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'مفتوحة',
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS suspects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    fake_account VARCHAR(255),
    details TEXT,
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    description TEXT NOT NULL,
    file_id VARCHAR(255),
    file_type VARCHAR(20),
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT,
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS independent_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_name VARCHAR(255) NOT NULL,
    account_link VARCHAR(255) NOT NULL,
    suspect_name VARCHAR(255),
    text_evidence TEXT,
    file_id VARCHAR(255),
    file_type VARCHAR(20),
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const COLS = {
  cases: ["title", "description"],
  suspects: ["case_id", "name", "fake_account", "details"],
  evidence: ["case_id", "description", "file_id", "file_type"],
  reports: ["case_id", "title", "body"],
  independent_accounts: [
    "account_name",
    "account_link",
    "suspect_name",
    "text_evidence",
    "file_id",
    "file_type",
  ],
};

const SEARCH_COLS = {
  cases: ["title", "description"],
  suspects: ["name", "fake_account", "details"],
  evidence: ["description"],
  reports: ["title", "body"],
  independent_accounts: [
    "account_name",
    "account_link",
    "suspect_name",
    "text_evidence",
  ],
};

const caseNo = (id) => `C-${String(id).padStart(4, "0")}`;

async function init() {
  for (const sql of SCHEMA) await pool.query(sql);
}

async function getUser(telegramId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE telegram_id = ?", [
    telegramId,
  ]);
  return rows[0] || null;
}

async function registerUser(telegramId, name, role = "member") {
  await pool.query(
    "INSERT INTO users (telegram_id, name, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = ?",
    [telegramId, name, role, name],
  );
}

async function add(kind, createdBy, fields) {
  const cols = COLS[kind];
  if (!cols) throw new Error("invalid kind");
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new TypeError("fields must be an object");
  const values = cols.map((c) => (fields[c] === undefined ? null : fields[c]));
  const sql = `INSERT INTO ${kind} (${cols.join(",")},created_by) VALUES (${[...cols, "created_by"].map(() => "?").join(",")})`;
  const [res] = await pool.query(sql, [...values, createdBy]);
  return res.insertId;
}

async function get(kind, id) {
  if (!COLS[kind]) throw new Error("invalid kind");
  const [rows] = await pool.query(`SELECT * FROM ${kind} WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function list(kind, caseId = 0, limit = 30) {
  if (!COLS[kind]) throw new Error("invalid kind");
  if (kind !== "cases" && kind !== "independent_accounts" && caseId) {
    const [rows] = await pool.query(
      `SELECT * FROM ${kind} WHERE case_id = ? ORDER BY id DESC LIMIT ?`,
      [caseId, limit],
    );
    return rows;
  }
  const [rows] = await pool.query(
    `SELECT * FROM ${kind} ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

async function countByCase(caseId) {
  const out = {};
  for (const k of ["suspects", "evidence", "reports"]) {
    const [r] = await pool.query(
      `SELECT COUNT(*) AS n FROM ${k} WHERE case_id = ?`,
      [caseId],
    );
    out[k] = r[0].n;
  }
  return out;
}

async function setStatus(caseId, status) {
  await pool.query("UPDATE cases SET status = ? WHERE id = ?", [
    status,
    caseId,
  ]);
}

async function remove(kind, id) {
  if (!COLS[kind]) throw new Error("invalid kind");
  const [result] = await pool.query(`DELETE FROM ${kind} WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

async function search(text, perKind = 8) {
  if (typeof text !== "string" || !text.trim())
    throw new TypeError("search text must be a non-empty string");
  const escaped = text.trim().replace(/[=%_]/g, "=$&");
  const like = `%${escaped}%`;
  const results = [];
  for (const [kind, cols] of Object.entries(SEARCH_COLS)) {
    const where = cols.map((c) => `${c} LIKE ? ESCAPE '='`).join(" OR ");
    const [rows] = await pool.query(
      `SELECT * FROM ${kind} WHERE ${where} ORDER BY id DESC LIMIT ?`,
      [...cols.map(() => like), perKind],
    );
    rows.forEach((r) => results.push([kind, r]));
  }
  let t = text.trim().toUpperCase();
  if (t.startsWith("C-")) t = t.slice(2);
  if (/^\d+$/.test(t)) {
    const c = await get("cases", Number(t));
    if (c && !results.some(([k, r]) => k === "cases" && r.id === c.id))
      results.unshift(["cases", c]);
  }
  return results;
}

module.exports = {
  init,
  close: () => pool.end(),
  getUser,
  registerUser,
  add,
  get,
  list,
  countByCase,
  setStatus,
  remove,
  search,
  caseNo,
};
