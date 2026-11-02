// Narrador de cuentos — Gemini TTS en castellano
// Un cuento = una petición (la cuota gratuita es de unas 10 peticiones al día).
// Solo se trocea el texto si supera el máximo de caracteres por petición.

const MODEL = "gemini-3.8-flash-tts";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const PAUSA_ENTRE_TROZOS_S = 21; // límite gratuito observado: 3 peticiones/minuto
const SILENCIO_ENTRE_TROZOS_S = 0.35;
// Pon aquí la dirección de tu Worker para que venga rellena (ej. "https://narrador.tu-usuario.workers.dev")
const PROXY_POR_DEFECTO = "https://narrador.sdfanstack.workers.dev";

const VOICES = [
  ["es-es-podcaster-5", "Podcaster 5 · mujer, de radio, con chispa"],
  ["es-es-training-12", "Training 12 · mujer, clara y amable"],
  ["es-es-csagent-6", "Call Center 6 · mujer, profesional y cercana"],
  ["es-es-concierge-3", "Concierge 3 · mujer, tranquila"],
  ["es-es-commercial-3", "Commercial 3 · mujer"],
  ["es-es-commercial-7", "Commercial 7 · mujer"],
  ["es-es-csagent-5", "Call Center 5 · mujer"],
  ["es-es-techagent-5", "Tech Advisor 5 · mujer"],
  ["es-es-tutor-12", "Tutor 12 · mujer"],
  ["es-es-training-11", "Training 11 · hombre, natural y claro"],
  ["es-es-podcaster-7", "Podcaster 7 · hombre, de radio"],
  ["es-es-concierge-12", "Concierge 12 · hombre, grave"],
  ["es-es-advisor-2", "Advisor 2 · hombre, grave"],
  ["es-es-advisor-9", "Advisor 9 · hombre"],
  ["es-es-assistant-3", "Assistant 3 · hombre"],
  ["es-es-assistant-4", "Assistant 4 · hombre"],
  ["es-es-concierge-4", "Concierge 4 · hombre"],
  ["es-es-csagent-3", "Call Center 3 · hombre"],
  ["es-es-techagent-4", "Tech Advisor 4 · hombre"],
  ["es-es-training-3", "Training 3 · hombre"],
  ["es-es-training-9", "Training 9 · hombre"],
  ["es-es-advisor-8", "Advisor 8 · neutra"],
];

const ESTILOS = {
  tierno:
    "Warm, gentle storyteller reading a children's tale. Expressive, with clear emphasis on key words, natural pauses and a soft, caring tone. Slow to medium pace.",
  aventura:
    "Lively storyteller, energetic and expressive, building suspense and excitement, strong emphasis on dramatic moments, varied intonation.",
  misterio:
    "Mysterious, hushed storytelling with dramatic pauses and rising tension, expressive intonation.",
  alegre:
    "Cheerful, playful and animated narration, very expressive, big changes of intonation, a smiling voice.",
};
const RITMOS = {
  normal: "",
  pausado: " Speak noticeably slowly, at a calm unhurried pace, with generous pauses between sentences and at commas.",
  muy: " Speak very slowly, as if reading to a sleepy small child, with long pauses between sentences, drawing words out gently.",
};
const SUFIJO_ESTILO = " Narrate in Castilian Spanish from Spain.";

// ---------- utilidades puras (se prueban en Node) ----------

function trocear(texto, max) {
  const limpio = texto.replace(/\r\n/g, "\n").trim();
  if (!limpio) return [];
  if (limpio.length <= max) return [limpio];

  const partes = [];
  for (const p of limpio.split(/\n\s*\n/)) {
    if (p.length <= max) {
      partes.push(p);
    } else {
      // párrafo enorme: partir por frases
      let actual = "";
      for (const f of p.split(/(?<=[.!?…])\s+/)) {
        if ((actual + " " + f).trim().length > max && actual) {
          partes.push(actual.trim());
          actual = f;
        } else {
          actual = (actual + " " + f).trim();
        }
      }
      if (actual) partes.push(actual.trim());
    }
  }
  // agrupar párrafos hasta el máximo
  const trozos = [];
  let cur = "";
  for (const p of partes) {
    if (cur && (cur + "\n\n" + p).length > max) {
      trozos.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  if (cur) trozos.push(cur);
  return trozos;
}

function base64ABytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function leerWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("La respuesta no es un WAV válido.");
  }
  let fmt = null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    let size = dv.getUint32(o + 4, true);
    const ini = o + 8;
    if (id === "fmt ") {
      fmt = {
        canales: dv.getUint16(ini + 2, true),
        frecuencia: dv.getUint32(ini + 4, true),
        bits: dv.getUint16(ini + 14, true),
      };
    } else if (id === "data") {
      if (ini + size > bytes.length) size = bytes.length - ini; // cabecera de tamaño desconocido
      if (!fmt) throw new Error("WAV sin bloque fmt.");
      return { ...fmt, pcm: bytes.subarray(ini, ini + size) };
    }
    o = ini + size + (size % 2);
  }
  throw new Error("WAV sin datos de audio.");
}

function unirWav(wavs, silencioS) {
  const f = wavs[0];
  const bytesPorSeg = f.frecuencia * f.canales * (f.bits / 8);
  const alineacion = f.canales * (f.bits / 8);
  let silencio = Math.round(bytesPorSeg * silencioS);
  silencio -= silencio % alineacion;

  let total = 0;
  wavs.forEach((w, i) => {
    total += w.pcm.length + (i < wavs.length - 1 ? silencio : 0);
  });

  const out = new Uint8Array(44 + total);
  const dv = new DataView(out.buffer);
  const esc = (o, s) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  esc(0, "RIFF");
  dv.setUint32(4, 36 + total, true);
  esc(8, "WAVE");
  esc(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, f.canales, true);
  dv.setUint32(24, f.frecuencia, true);
  dv.setUint32(28, bytesPorSeg, true);
  dv.setUint16(32, alineacion, true);
  dv.setUint16(34, f.bits, true);
  esc(36, "data");
  dv.setUint32(40, total, true);

  let pos = 44;
  wavs.forEach((w, i) => {
    out.set(w.pcm, pos);
    pos += w.pcm.length;
    if (i < wavs.length - 1) pos += silencio; // ya está a cero
  });
  return out;
}

function buscarAudioBase64(obj) {
  // La respuesta trae el audio en steps[].content[].data (base64)
  let hallado = null;
  (function rec(x) {
    if (hallado || x === null || typeof x !== "object") return;
    if (typeof x.data === "string" && x.data.length > 1000) {
      hallado = x.data;
      return;
    }
    for (const k of Object.keys(x)) rec(x[k]);
  })(obj);
  return hallado;
}

function mensajeError(status, detalle) {
  const base = {
    400: "Petición no válida (revisa la voz o el texto).",
    401: "La clave de API no es correcta.",
    403: "Sin permisos: revisa la clave y el proyecto en Google AI Studio.",
    429: "Se ha agotado la cuota gratuita (o demasiadas peticiones seguidas). Espera un rato o hasta mañana y no insistas.",
  }[status];
  return (base || `Error ${status}.`) + (detalle ? ` (${detalle})` : "");
}

if (typeof module !== "undefined") {
  module.exports = { trocear, leerWav, unirWav, buscarAudioBase64, base64ABytes };
}

// ---------- interfaz (solo en el navegador) ----------

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const leer = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

  let cancelar = false;
  let urlAudio = null;

  function contadorHoy() {
    const d = new Date().toISOString().slice(0, 10);
    return { clave: "tts_n_" + d, n: parseInt(leer("tts_n_" + d) || "0", 10) };
  }
  function pintarContador() {
    $("contador").textContent = contadorHoy().n;
  }
  function sumarPeticion() {
    const c = contadorHoy();
    guardar(c.clave, String(c.n + 1));
    pintarContador();
  }

  function estado(msg, error) {
    const e = $("estado");
    e.textContent = msg;
    e.className = error ? "error" : "";
  }

  function estiloActual() {
    const sel = $("estilo").value;
    const base = sel === "personalizado" ? $("estiloLibre").value.trim() : ESTILOS[sel];
    return (base || ESTILOS.tierno) + (RITMOS[$("ritmo").value] || "") + SUFIJO_ESTILO;
  }

  async function pedirAudio(texto, voz, estilo, clave, proxy) {
    const body = {
      model: MODEL,
      input: [{
        type: "user_input",
        content: [{ type: "text", text: texto, annotations: [{ type: "speech_metadata", style: estilo }] }],
      }],
      response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: voz }] },
    };
    const headers = { "Content-Type": "application/json" };
    if (!proxy) headers["x-goog-api-key"] = clave;
    else if (document.getElementById("pass").value) headers["X-Familia"] = document.getElementById("pass").value;

    sumarPeticion();
    let r;
    try {
      r = await fetch(proxy || ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error("No hay conexión con Google (o el navegador la ha bloqueado). Si pasa siempre, usa el proxy del archivo worker.js.");
    }
    if (!r.ok) {
      let det = "";
      try { det = (await r.json()).error?.message || ""; } catch (e) {}
      throw new Error(mensajeError(r.status, det.slice(0, 160)));
    }
    const b64 = buscarAudioBase64(await r.json());
    if (!b64) throw new Error("Google respondió, pero sin audio.");
    return leerWav(base64ABytes(b64));
  }

  async function generar(texto, soloPrueba) {
    const proxy = $("proxy").value.trim();
    const clave = $("clave").value.trim();
    if (!proxy && !clave) return estado("Falta la clave de API de Gemini.", true);
    if (!texto.trim()) return estado("Escribe o pega el texto del cuento.", true);

    guardar("tts_clave", clave);
    guardar("tts_proxy", proxy);
    guardar("tts_pass", $("pass").value);
    guardar("tts_voz", $("voz").value);
    guardar("tts_estilo", $("estilo").value);
    guardar("tts_ritmo", $("ritmo").value);
    guardar("tts_estiloLibre", $("estiloLibre").value);

    const max = Math.max(1000, parseInt($("max").value, 10) || 8000);
    const trozos = soloPrueba ? [texto.trim().slice(0, 300)] : trocear(texto, max);
    if (trozos.length > 1) {
      const ok = confirm(
        `Este texto es largo y se enviará en ${trozos.length} peticiones. ` +
        `Cada una gasta una de tus ~10 peticiones gratis del día y tarda ~${PAUSA_ENTRE_TROZOS_S}s de espera entre ellas. ¿Seguimos?`
      );
      if (!ok) return;
    }

    cancelar = false;
    $("generar").disabled = $("probar").disabled = true;
    $("cancelar").hidden = false;
    $("resultado").hidden = true;

    const wavs = [];
    try {
      for (let i = 0; i < trozos.length; i++) {
        if (cancelar) throw new Error("Cancelado.");
        estado(trozos.length > 1
          ? `Narrando parte ${i + 1} de ${trozos.length}…`
          : "Narrando… puede tardar un minuto.");
        wavs.push(await pedirAudio(trozos[i], $("voz").value, estiloActual(), clave, proxy));
        if (i < trozos.length - 1) {
          for (let s = PAUSA_ENTRE_TROZOS_S; s > 0; s--) {
            if (cancelar) throw new Error("Cancelado.");
            estado(`Parte ${i + 1} lista. Esperando ${s}s para no pasarnos del límite…`);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      const salida = wavs.length === 1 ? null : unirWav(wavs, SILENCIO_ENTRE_TROZOS_S);
      let blob;
      if (salida) {
        blob = new Blob([salida], { type: "audio/wav" });
      } else {
        blob = new Blob([unirWav(wavs, 0)], { type: "audio/wav" });
      }
      if (urlAudio) URL.revokeObjectURL(urlAudio);
      urlAudio = URL.createObjectURL(blob);
      $("reproductor").src = urlAudio;
      const nombre = ($("titulo").value.trim() || "cuento").replace(/[^\w\- áéíóúñÁÉÍÓÚÑ]/g, "") + ".wav";
      $("descargar").href = urlAudio;
      $("descargar").download = soloPrueba ? "prueba.wav" : nombre;
      $("resultado").hidden = false;
      estado(soloPrueba ? "Prueba lista. Si te gusta la voz, genera el cuento entero." : "¡Listo!");
    } catch (e) {
      estado(e.message, e.message !== "Cancelado.");
    } finally {
      $("generar").disabled = $("probar").disabled = false;
      $("cancelar").hidden = true;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    VOICES.forEach(([id, nombre]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = nombre;
      $("voz").appendChild(o);
    });
    $("clave").value = leer("tts_clave") || "";
    $("proxy").value = leer("tts_proxy") || PROXY_POR_DEFECTO;
    $("pass").value = leer("tts_pass") || "";
    if (leer("tts_voz")) $("voz").value = leer("tts_voz");
    if (leer("tts_estilo")) $("estilo").value = leer("tts_estilo");
    if (leer("tts_ritmo")) $("ritmo").value = leer("tts_ritmo");
    $("estiloLibre").value = leer("tts_estiloLibre") || "";

    const mostrarLibre = () => ($("libreBox").hidden = $("estilo").value !== "personalizado");
    $("estilo").addEventListener("change", mostrarLibre);
    mostrarLibre();

    const contar = () => ($("chars").textContent = $("texto").value.length.toLocaleString("es-ES"));
    $("texto").addEventListener("input", contar);
    contar();

    $("generar").addEventListener("click", () => generar($("texto").value, false));
    $("probar").addEventListener("click", () => generar($("texto").value || "Había una vez, en un bosque muy lejano, un zorrito que soñaba con tocar la luna.", true));
    $("cancelar").addEventListener("click", () => (cancelar = true));
    pintarContador();
  });
}
