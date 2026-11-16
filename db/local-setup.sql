-- One-time local PostgreSQL setup for development and integration tests.
-- Run as a PostgreSQL superuser:  psql -U postgres -f db/local-setup.sql
-- No passwords are set here; see docs/getting-started.md (section 2) for the \password step.
-- Fails loudly if a role or database already exists, so it never overwrites anything.

CREATE ROLE babysunray_dev  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE babysunray_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- ENCODING 'UTF8' is required for Bangla text; the statement errors if the server cannot provide it.
CREATE DATABASE babysunray_dev  OWNER babysunray_dev  ENCODING 'UTF8';
CREATE DATABASE babysunray_test OWNER babysunray_test ENCODING 'UTF8';

-- Each role can reach only its own database.
REVOKE CONNECT ON DATABASE babysunray_dev  FROM PUBLIC;
REVOKE CONNECT ON DATABASE babysunray_test FROM PUBLIC;
