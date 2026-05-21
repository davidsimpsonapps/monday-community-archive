export async function onRequest({ params, env }) {
  const key = "api/" + params.path.join("/");
  const object = await env.API_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: { "Content-Type": "application/json" },
  });
}
