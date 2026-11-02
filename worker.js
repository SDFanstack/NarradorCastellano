// Proxy para Cloudflare Workers: guarda la clave de Gemini en el servidor
// y solo deja pasar peticiones de voz de quien sepa la contraseña.
//
// Ajustes del Worker (Settings → Variables and Secrets):
//   GEMINI_API_KEY  (Secret)    tu clave de Gemini
//   CONTRASENA      (Secret)    la contraseña de la familia (la misma que escribirás en la web)
//   ALLOWED_ORIGIN  (Variable)  la dirección de tu web, ej. https://narrador.pages.dev (sin "/" al final)

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_BYTES = 60000; // un cuento de 8.000 caracteres ocupa mucho menos

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Familia",
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: { message: "Método no permitido" } }, 405);

    if (!env.GEMINI_API_KEY || !env.CONTRASENA) {
      return json({ error: { message: "Falta configurar GEMINI_API_KEY o CONTRASENA en el Worker" } }, 500);
    }
    if (request.headers.get("X-Familia") !== env.CONTRASENA) {
      return json({ error: { message: "Contraseña incorrecta" } }, 403);
    }

    const cuerpo = await request.text();
    if (cuerpo.length > MAX_BYTES) return json({ error: { message: "Texto demasiado largo" } }, 413);

    let datos;
    try { datos = JSON.parse(cuerpo); } catch (e) { return json({ error: { message: "JSON no válido" } }, 400); }
    if (!String(datos.model || "").includes("tts")) {
      return json({ error: { message: "Solo se permiten modelos de voz" } }, 400);
    }

    const respuesta = await fetch(GEMINI, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: cuerpo,
    });

    return new Response(respuesta.body, {
      status: respuesta.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
