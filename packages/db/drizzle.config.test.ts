import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url:
      process.env.TEST_DATABASE_URL ||
      "postgres://postgres:postgres@localhost:5433/midday_test",
  },
  verbose: true,
});
