// PUT /api/appointments/:id    -> update an appointment
// DELETE /api/appointments/:id -> delete an appointment
// Requires a D1 binding named "DB" on the Pages project.

export async function onRequestPut(context) {
  const { env, request, params } = context;
  const id = params.id;

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

  try {
    const result = await env.DB.prepare(
      `UPDATE appointments SET name=?, phone=?, jy=?, jm=?, jd=?, hour=?, minute=? WHERE id=?`
    ).bind(name, phone, jy, jm, jd, hour, minute, id).run();

    if (result.meta.changes === 0) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return Response.json({ error: "time_conflict" }, { status: 409 });
    }
    return Response.json({ error: "db_error", message: err.message }, { status: 500 });
  }

  return Response.json({ id, name, phone, jy, jm, jd, hour, minute });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = params.id;

  try {
    await env.DB.prepare(`DELETE FROM appointments WHERE id=?`).bind(id).run();
  } catch (err) {
    return Response.json({ error: "db_error", message: err.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
