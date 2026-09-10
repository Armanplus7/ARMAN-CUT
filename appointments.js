// GET /api/appointments  -> list all appointments
// POST /api/appointments -> create a new appointment
// Requires a D1 binding named "DB" on the Pages project.

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, name, phone, jy, jm, jd, hour, minute FROM appointments ORDER BY jy, jm, jd, hour, minute"
    ).all();
    return Response.json(results);
  } catch (err) {
    return Response.json({ error: "db_error", message: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const name = (body.name || "").toString().trim();
  const phone = (body.phone || "").toString().trim();
  const { jy, jm, jd, hour, minute } = body;

  if (!name && !phone) {
    return Response.json({ error: "name_or_phone_required" }, { status: 400 });
  }
  if (![jy, jm, jd, hour, minute].every(Number.isInteger)) {
    return Response.json({ error: "invalid_date_time" }, { status: 400 });
  }

  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO appointments (id, name, phone, jy, jm, jd, hour, minute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, phone, jy, jm, jd, hour, minute).run();
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return Response.json({ error: "time_conflict" }, { status: 409 });
    }
    return Response.json({ error: "db_error", message: err.message }, { status: 500 });
  }

  return Response.json({ id, name, phone, jy, jm, jd, hour, minute }, { status: 201 });
}
