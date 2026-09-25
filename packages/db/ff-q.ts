import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
console.log(JSON.stringify(await sql`select id, status, amount, subtotal, vat, tax, discount, line_items from invoices order by created_at`));
await sql.end();
