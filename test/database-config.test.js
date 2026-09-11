"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { connectionOptions } = require("../storage/postgres");

test("Azure require mode still verifies certificates and cannot disable TLS", () => {
  const url = "postgresql://appuser@aman.postgres.database.azure.com:5432/authorized_database";
  const options = connectionOptions({ databaseUrl: url, databaseSsl: "require" });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.throws(() => connectionOptions({ databaseUrl: url, databaseSsl: "disable" }), /TLS/);
});

test("local Compose credentials may come from PGPASSWORD without URL interpolation", () => {
  const previous = process.env.PGPASSWORD;
  const generated = `${crypto.randomBytes(8).toString("hex")}@:/$`;
  process.env.PGPASSWORD = generated;
  try {
    const options = connectionOptions({
      databaseUrl: "postgresql://hearthlands@db:5432/hearthlands", databaseSsl: "disable",
    });
    assert.equal(options.user, "hearthlands");
    assert.equal(options.password === generated, true);
    assert.equal(options.ssl, false);
  } finally {
    if (previous === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = previous;
  }
});
