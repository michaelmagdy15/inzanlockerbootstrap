-- h:/inzanlockerbootstrap/migrations/001_init_gym_locker.sql
CREATE TABLE IF NOT EXISTS members (
  id VARCHAR(50) PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  gender VARCHAR(10) NOT NULL CHECK(gender IN ('male', 'female')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS lockers (
  id VARCHAR(10) PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  access_token VARCHAR(64),
  assigned_at BIGINT
);

CREATE TABLE IF NOT EXISTS locker_assignments (
  id SERIAL PRIMARY KEY,
  member_id VARCHAR(50) NOT NULL REFERENCES members(id),
  locker_id VARCHAR(10) REFERENCES lockers(id),
  locker_token VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL CHECK(status IN ('issued', 'allocated', 'vacated', 'expired')),
  issued_at BIGINT NOT NULL,
  assigned_at BIGINT,
  vacated_at BIGINT
);
