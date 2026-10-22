/**
 * app.js — Interfaz y lógica de la aplicación.
 *
 * Tres vistas:
 *   • Hoy       → registrar peso / repeticiones / series de cada ejercicio del día.
 *   • Plan      → definir grupos musculares y ejercicios de cada día de la semana.
 *   • Progreso  → gráfica e historial de un ejercicio a lo largo del tiempo.
 *
 * Funcionamiento: los datos llegan "en vivo" desde Firestore (db.js) y se guardan
 * en el objeto `estado`. Cada vez que algo cambia se vuelve a dibujar la vista
 * actual (función pintar). Los clics y envíos de formularios se gestionan con
 * "delegación de eventos": un solo escuchador en #vista que mira data-accion.
 */
import * as DB from "./db.js";
import { dibujarGrafica } from "./grafica.js";

/* ====================================================================== */
/*  Constantes                                                            */
/* ====================================================================== */

const DIAS = [
  { id: "lunes", corto: "Lun", nombre: "Lunes" },
  { id: "martes", corto: "Mar", nombre: "Martes" },
  { id: "miercoles", corto: "Mié", nombre: "Miércoles" },
  { id: "jueves", corto: "Jue", nombre: "Jueves" },
  { id: "viernes", corto: "Vie", nombre: "Viernes" },
  { id: "sabado", corto: "Sáb", nombre: "Sábado" },
  { id: "domingo", corto: "Dom", nombre: "Domingo" },
];

// Sugerencias al añadir un grupo muscular (el usuario puede escribir cualquier otro).
const GRUPOS_SUGERIDOS = [
  "Pecho", "Espalda", "Hombros", "Bíceps", "Tríceps", "Cuádriceps",
  "Femorales", "Glúteos", "Pantorrillas", "Abdomen", "Antebrazos", "Trapecio",
];

// Valores iniciales de un ejercicio que aún no tiene historial.
const POR_DEFECTO = { reps: "10", series: "3" };

/* ====================================================================== */
/*  Utilidades                                                            */
/* ====================================================================== */

const $ = (selector, raiz = document) => raiz.querySelector(selector);

/** Escapa texto del usuario antes de meterlo en HTML (evita inyección de código). */
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const nombreDia = (id) => DIAS.find((d) => d.id === id)?.nombre ?? id;

/** Id del día de hoy. Date.getDay() devuelve 0 = domingo, por eso se desplaza. */
function diaDeHoy() {
  return DIAS[(new Date().getDay() + 6) % 7].id;
}

/** Fecha local en formato AAAA-MM-DD (no usamos toISOString porque da la fecha en UTC). */
function fechaISO(fecha = new Date()) {
  const dos = (n) => String(n).padStart(2, "0");
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

function aFecha(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d);
}
const fechaCorta = (iso) => aFecha(iso).toLocaleDateString("es", { day: "numeric", month: "short" }).replace(".", "");
const fechaLarga = (iso) => aFecha(iso).toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "");

/** Número sin ceros sobrantes (62.50 → "62.5"). */
const num = (n) => String(Math.round(Number(n) * 100) / 100);

/** Texto de un registro: "60 kg × 8 reps × 3 series". */
const textoRegistro = (r) => `${num(r.peso)} kg × ${r.reps} reps × ${r.series} series`;

/* ====================================================================== */
/*  Estado                                                                */
/* ====================================================================== */

const estado = {
  vista: "hoy",                 // "hoy" | "plan" | "progreso"
  diaHoy: diaDeHoy(),           // día mostrado en la vista Hoy
  diaPlan: diaDeHoy(),          // día mostrado en la vista Plan
  ejercicioProgreso: null,      // ejercicio elegido en Progreso
  metrica: "peso",              // "peso" | "volumen"
  // Datos que llegan de Firestore:
  planes: {},                   // { lunes: { grupos: [...] }, … }
  ejercicios: [],               // [{ id, dia, grupo, nombre, creado }]
  registros: [],                // [{ id, ejercicioId, fecha, peso, reps, series, ts }]
  listo: { planes: false, ejercicios: false, registros: false },
  // Valores a medio escribir en las tarjetas de "Hoy" (para no perderlos al redibujar):
  borradores: {},
  foco: null,                   // selector del campo a enfocar tras redibujar
};

let cancelarSuscripciones = [];

/* ----- Consultas sobre los datos ----- */

const ejerciciosDe = (dia, grupo) => estado.ejercicios.filter((e) => e.dia === dia && e.grupo === grupo);
const registrosDe = (ejercicioId) => estado.registros.filter((r) => r.ejercicioId === ejercicioId);
const gruposDe = (dia) => estado.planes[dia]?.grupos ?? [];

/** Agrupa los registros de un ejercicio por fecha → una "sesión" por día entrenado. */
function sesionesDe(registros) {
  const porFecha = new Map();
  for (const r of registros) {
    const s = porFecha.get(r.fecha) ?? { fecha: r.fecha, pesoMax: 0, volumen: 0, registros: [] };
    s.pesoMax = Math.max(s.pesoMax, r.peso);
    s.volumen += r.peso * r.reps * r.series; // volumen = kg totales levantados
    s.registros.push(r);
    porFecha.set(r.fecha, s);
  }
  return [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/* ====================================================================== */
/*  Avisos y errores                                                      */
/* ====================================================================== */

let temporizadorAviso;
function aviso(mensaje, tipo = "ok") {
  const t = $("#toast");
  t.textContent = mensaje;
  t.className = `visible ${tipo}`;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { t.className = ""; }, 2400);
}

function alFallar(err) {
  console.error(err);
  aviso(`Error: ${err.code || err.message}`, "error");
}

/**
 * Ejecuta una operación de escritura sin bloquear la pantalla.
 * Firestore actualiza la vista al instante con la copia local y confirma con el servidor
 * después (o cuando vuelva la conexión), así que no hace falta esperar la respuesta.
 */
function tarea(operacion) {
  try { Promise.resolve(operacion()).catch(alFallar); } catch (err) { alFallar(err); }
}

/* ====================================================================== */
/*  Dibujado                                                              */
/* ====================================================================== */

let dibujoPendiente = false;
/** Pide redibujar; agrupa varios cambios seguidos en un solo dibujado. */
function render() {
  if (dibujoPendiente) return;
  dibujoPendiente = true;
  requestAnimationFrame(() => { dibujoPendiente = false; pintar(); });
}

function pintar() {
  document.querySelectorAll(".tabbar [data-vista]").forEach((b) => {
    b.classList.toggle("activa", b.dataset.vista === estado.vista);
  });

  const vista = $("#vista");
  if (!Object.values(estado.listo).every(Boolean)) {
    vista.innerHTML = `<p class="vacio">Cargando tus datos…</p>`;
    return;
  }
  const vistas = { hoy: vistaHoy, plan: vistaPlan, progreso: vistaProgreso };
  vista.innerHTML = vistas[estado.vista]();

  if (estado.foco) {
    $(estado.foco)?.focus();
    estado.foco = null;
  }
}

/** Mensaje de "no hay nada aquí" con un botón para ir a otra vista. */
function vacio(mensaje, textoBoton, vistaDestino) {
  return `<div class="vacio"><p>${mensaje}</p>
    <button type="button" class="primario" data-accion="ir" data-vista="${vistaDestino}">${textoBoton}</button></div>`;
}

/** Fila de 7 botones (Lun … Dom). */
function selectorDias(activo) {
  const hoy = diaDeHoy();
  return `<div class="dias" role="tablist" aria-label="Día de la semana">${DIAS.map((d) => `
    <button type="button" role="tab" aria-selected="${d.id === activo}"
      class="dia${d.id === activo ? " activo" : ""}${d.id === hoy ? " es-hoy" : ""}"
      data-accion="dia" data-dia="${d.id}" aria-label="${d.nombre}">${d.corto}</button>`).join("")}</div>`;
}

/* ----------------------------- Vista: HOY ---------------------------- */

function vistaHoy() {
  const dia = estado.diaHoy;
  const grupos = gruposDe(dia);

  let html = selectorDias(dia);
  html += `<h2 class="titulo-dia">${nombreDia(dia)}${dia === diaDeHoy() ? ' <span class="etiqueta">hoy</span>' : ""}</h2>`;

  if (!grupos.length) {
    return html + vacio(`No hay plan para el ${nombreDia(dia).toLowerCase()}.`, "Crear plan", "plan");
  }

  for (const grupo of grupos) {
    const lista = ejerciciosDe(dia, grupo);
    html += `<section class="grupo"><h3>${esc(grupo)}</h3>`;
    html += lista.length
      ? lista.map(tarjetaEjercicio).join("")
      : `<p class="nota">Aún no hay ejercicios para este grupo. Añádelos en la pestaña Plan.</p>`;
    html += `</section>`;
  }
  return html;
}

/** Un campo con botones − y + grandes (más cómodo que teclear en el gimnasio). */
function campoNumerico({ nombre, etiqueta, valor, paso, min, decimal }) {
  return `<div class="campo ${nombre}">
    <span class="campo-etq">${etiqueta}</span>
    <div class="stepper">
      <button type="button" data-accion="paso" data-paso="${-paso}" aria-label="Restar ${paso} a ${etiqueta}">−</button>
      <input name="${nombre}" type="number" step="any" min="${min}" inputmode="${decimal ? "decimal" : "numeric"}"
        value="${esc(valor)}" placeholder="0" required aria-label="${etiqueta}">
      <button type="button" data-accion="paso" data-paso="${paso}" aria-label="Sumar ${paso} a ${etiqueta}">+</button>
    </div>
  </div>`;
}

function tarjetaEjercicio(e) {
  const registros = registrosDe(e.id);
  const hoy = fechaISO();
  const ultimo = registros[registros.length - 1];                          // el más reciente (para rellenar los campos)
  const anterior = [...registros].reverse().find((r) => r.fecha < hoy);    // última sesión ANTERIOR a hoy (referencia)
  const deHoy = registros.filter((r) => r.fecha === hoy);
  const borrador = estado.borradores[e.id] ?? {};

  // Prioridad: lo que el usuario estaba escribiendo > último registro > valor por defecto.
  const valor = (campo, defecto) => borrador[campo] ?? (ultimo ? num(ultimo[campo]) : defecto);

  return `
  <form class="ej" data-form="registro" data-ej="${e.id}" autocomplete="off">
    <div class="ej-cab">
      <h4>${esc(e.nombre)}</h4>
      <button type="button" data-accion="ir-progreso" data-id="${e.id}" aria-label="Ver progreso de ${esc(e.nombre)}">📈</button>
    </div>
    <p class="ultima">${anterior ? `Anterior (${fechaCorta(anterior.fecha)}): ${textoRegistro(anterior)}` : "Sin sesiones anteriores"}</p>
    <div class="campos">
      ${campoNumerico({ nombre: "peso", etiqueta: "Peso (kg)", valor: valor("peso", ""), paso: 2.5, min: 0, decimal: true })}
      ${campoNumerico({ nombre: "reps", etiqueta: "Repeticiones", valor: valor("reps", POR_DEFECTO.reps), paso: 1, min: 1 })}
      ${campoNumerico({ nombre: "series", etiqueta: "Series", valor: valor("series", POR_DEFECTO.series), paso: 1, min: 1 })}
    </div>
    <button class="primario grande">Guardar sesión</button>
    ${deHoy.length ? `<ul class="hechos" aria-label="Registrado hoy">${deHoy.map((r) => `
      <li><span>✔ ${textoRegistro(r)}</span>
        <button type="button" data-accion="borrar-registro" data-id="${r.id}" aria-label="Eliminar este registro">✕</button></li>`).join("")}</ul>` : ""}
  </form>`;
}

/* ----------------------------- Vista: PLAN --------------------------- */

function vistaPlan() {
  const dia = estado.diaPlan;
  const grupos = gruposDe(dia);
  const libres = GRUPOS_SUGERIDOS.filter((g) => !grupos.includes(g));

  let html = selectorDias(dia);

  html += `<section class="tarjeta">
    <h2>Grupos musculares del ${nombreDia(dia).toLowerCase()}</h2>
    ${grupos.length ? `<div class="chips">${grupos.map((g) => `
      <span class="chip">${esc(g)}
        <button type="button" data-accion="quitar-grupo" data-grupo="${esc(g)}" aria-label="Quitar ${esc(g)}">✕</button></span>`).join("")}</div>`
      : `<p class="nota">Aún no hay grupos. Añade el primero (por ejemplo, Pecho).</p>`}
    <form class="fila" data-form="grupo" autocomplete="off">
      <input name="grupo" list="lista-grupos" placeholder="Añadir grupo muscular" maxlength="40" required aria-label="Nuevo grupo muscular">
      <datalist id="lista-grupos">${libres.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
      <button class="primario">Añadir</button>
    </form>
  </section>`;

  for (const grupo of grupos) {
    const lista = ejerciciosDe(dia, grupo);
    html += `<section class="tarjeta">
      <h3>${esc(grupo)}</h3>
      ${lista.length ? `<ul class="lista">${lista.map((e) => `
        <li class="fila-ej"><span class="nombre">${esc(e.nombre)}</span>
          <button type="button" class="icono" data-accion="editar-ejercicio" data-id="${e.id}" aria-label="Editar ${esc(e.nombre)}">✎</button>
          <button type="button" class="icono peligro" data-accion="borrar-ejercicio" data-id="${e.id}" aria-label="Eliminar ${esc(e.nombre)}">🗑</button></li>`).join("")}</ul>`
        : `<p class="nota">Sin ejercicios todavía.</p>`}
      <form class="fila" data-form="ejercicio" data-grupo="${esc(grupo)}" autocomplete="off">
        <input name="nombre" placeholder="Nuevo ejercicio (ej. Press banca)" maxlength="60" required aria-label="Nuevo ejercicio de ${esc(grupo)}">
        <button class="primario" aria-label="Añadir ejercicio">+</button>
      </form>
    </section>`;
  }
  return html;
}

/* --------------------------- Vista: PROGRESO ------------------------- */

function vistaProgreso() {
  // Todos los ejercicios, ordenados por día de la semana.
  const todos = DIAS.flatMap((d) => estado.ejercicios.filter((e) => e.dia === d.id));
  if (!todos.length) {
    return vacio("Cuando crees ejercicios y registres sesiones, verás aquí tu progresión.", "Ir al plan", "plan");
  }
  const sel = todos.find((e) => e.id === estado.ejercicioProgreso) ?? todos[0];

  const opciones = DIAS.map((d) => {
    const delDia = todos.filter((e) => e.dia === d.id);
    if (!delDia.length) return "";
    return `<optgroup label="${d.nombre}">${delDia.map((e) =>
      `<option value="${e.id}"${e.id === sel.id ? " selected" : ""}>${esc(e.grupo)} · ${esc(e.nombre)}</option>`).join("")}</optgroup>`;
  }).join("");

  let html = `<div class="controles">
    <label>Ejercicio<select id="sel-ejercicio">${opciones}</select></label>
    <div class="segmentado" role="group" aria-label="Qué medir">
      <button type="button" data-accion="metrica" data-metrica="peso" class="${estado.metrica === "peso" ? "activo" : ""}">Peso máximo</button>
      <button type="button" data-accion="metrica" data-metrica="volumen" class="${estado.metrica === "volumen" ? "activo" : ""}">Volumen total</button>
    </div>
  </div>`;

  const sesiones = sesionesDe(registrosDe(sel.id));
  if (!sesiones.length) {
    return html + `<p class="vacio">Aún no hay registros de «${esc(sel.nombre)}».<br>Guárdalos desde la pestaña Hoy.</p>`;
  }

  const esPeso = estado.metrica === "peso";
  const valores = sesiones.map((s) => (esPeso ? s.pesoMax : s.volumen));
  const primero = valores[0];
  const actual = valores[valores.length - 1];
  const mejor = Math.max(...valores);
  const cambio = actual - primero;
  const pct = primero > 0 ? ` (${cambio >= 0 ? "+" : ""}${Math.round((cambio / primero) * 100)} %)` : "";
  const clase = cambio > 0 ? "sube" : cambio < 0 ? "baja" : "";
  const unidad = "kg";

  html += `<section class="tarjeta">
    <h3>${esc(sel.nombre)} · ${sesiones.length} ${sesiones.length === 1 ? "sesión" : "sesiones"}</h3>
    <div class="stats">
      <div class="stat"><b>${num(actual)}</b><span>Actual (${unidad})</span></div>
      <div class="stat"><b>${num(mejor)}</b><span>Mejor (${unidad})</span></div>
      <div class="stat"><b class="${clase}">${cambio > 0 ? "+" : ""}${num(cambio)}</b><span>Cambio${esc(pct)}</span></div>
    </div>
    <div class="grafica">${dibujarGrafica(
      sesiones.slice(-40).map((s) => ({ x: fechaCorta(s.fecha), y: esPeso ? s.pesoMax : s.volumen })), unidad)}</div>
  </section>`;

  html += `<section class="tarjeta"><h3>Historial</h3>${[...sesiones].reverse().map((s) => `
    <div class="sesion"><h4>${fechaLarga(s.fecha)}</h4><ul>${s.registros.map((r) => `
      <li><span>${textoRegistro(r)}</span>
        <button type="button" data-accion="borrar-registro" data-id="${r.id}" aria-label="Eliminar este registro">✕</button></li>`).join("")}</ul></div>`).join("")}
  </section>`;
  return html;
}

/* ====================================================================== */
/*  Eventos                                                               */
/* ====================================================================== */

const vista = $("#vista");
const modal = $("#modal");

/* ----- Clics (botones con data-accion) ----- */
vista.addEventListener("click", (ev) => {
  const boton = ev.target.closest("[data-accion]");
  if (!boton) return;
  const d = boton.dataset;

  switch (d.accion) {
    case "dia": // elegir día en Hoy o en Plan
      estado[estado.vista === "plan" ? "diaPlan" : "diaHoy"] = d.dia;
      render();
      break;

    case "ir": // botón "Crear plan" / "Ir al plan"
      if (d.vista === "plan") estado.diaPlan = estado.diaHoy;
      irA(d.vista);
      break;

    case "ir-progreso": // icono 📈 de una tarjeta de Hoy
      estado.ejercicioProgreso = d.id;
      irA("progreso");
      break;

    case "paso": { // botones − y +
      const campo = boton.closest(".stepper").querySelector("input");
      const min = parseFloat(campo.min) || 0;
      const nuevo = (parseFloat(campo.value) || 0) + parseFloat(d.paso);
      campo.value = Math.max(min, Math.round(nuevo * 100) / 100);
      recordarBorrador(campo);
      break;
    }

    case "borrar-registro":
      if (confirm("¿Eliminar este registro?")) tarea(() => DB.eliminarRegistro(d.id));
      break;

    case "metrica":
      estado.metrica = d.metrica;
      render();
      break;

    case "quitar-grupo": quitarGrupo(d.grupo); break;
    case "editar-ejercicio": abrirEditor(d.id); break;
    case "borrar-ejercicio": borrarEjercicio(d.id); break;
  }
});

/* ----- Formularios ----- */
vista.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.target.closest("form[data-form]");
  if (!form) return;
  const datos = new FormData(form);

  switch (form.dataset.form) {
    case "registro": guardarRegistro(form.dataset.ej, datos); break;
    case "grupo": anadirGrupo(String(datos.get("grupo"))); break;
    case "ejercicio": anadirEjercicio(form.dataset.grupo, String(datos.get("nombre"))); break;
  }
});

/* ----- Guardar lo que se va escribiendo (para no perderlo si la vista se redibuja) ----- */
vista.addEventListener("input", (ev) => recordarBorrador(ev.target));

function recordarBorrador(campo) {
  const tarjeta = campo.closest("[data-ej]");
  if (!tarjeta || !campo.name) return;
  (estado.borradores[tarjeta.dataset.ej] ??= {})[campo.name] = campo.value;
}

/* ----- Al tocar un campo numérico, se selecciona su contenido para sobrescribir rápido ----- */
vista.addEventListener("focusin", (ev) => {
  if (ev.target.matches('input[type="number"]')) ev.target.select();
});

/* ----- Selector de ejercicio en Progreso ----- */
vista.addEventListener("change", (ev) => {
  if (ev.target.id === "sel-ejercicio") {
    estado.ejercicioProgreso = ev.target.value;
    render();
  }
});

/* ----- Ventana de edición ----- */
modal.addEventListener("click", (ev) => {
  if (ev.target === modal || ev.target.closest("[data-accion='cerrar-modal']")) modal.close();
});
modal.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const datos = new FormData(form);
  const nombre = String(datos.get("nombre")).trim();
  if (!nombre) return;
  tarea(() => DB.editarEjercicio(form.dataset.ej, { nombre, grupo: String(datos.get("grupo")) }));
  modal.close();
});

/* ====================================================================== */
/*  Acciones                                                              */
/* ====================================================================== */

function irA(destino) {
  estado.vista = destino;
  render();
  window.scrollTo({ top: 0 });
}

function guardarRegistro(ejercicioId, datos) {
  const peso = parseFloat(datos.get("peso"));
  const reps = parseInt(datos.get("reps"), 10);
  const series = parseInt(datos.get("series"), 10);

  if (!(peso >= 0)) return aviso("Indica el peso (puede ser 0)", "error");
  if (!(reps >= 1) || !(series >= 1)) return aviso("Repeticiones y series deben ser al menos 1", "error");

  tarea(() => DB.crearRegistro({ ejercicioId, fecha: fechaISO(), peso, reps, series }));
  // Dejamos los valores en la tarjeta: la próxima sesión casi siempre parte de ellos.
  estado.borradores[ejercicioId] = { peso: num(peso), reps: String(reps), series: String(series) };
  aviso("Guardado ✔");
  ofrecerTemporizador(); // tras cada serie: ¿60 o 90 s de descanso?
}

/** Primera letra en mayúscula: "pecho" → "Pecho". */
const capitalizar = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function anadirGrupo(texto) {
  const nombre = capitalizar(texto.trim());
  if (!nombre) return;
  const dia = estado.diaPlan;
  const grupos = gruposDe(dia);
  if (grupos.some((g) => g.toLowerCase() === nombre.toLowerCase())) {
    return aviso("Ese grupo ya está en este día", "error");
  }
  tarea(() => DB.guardarPlan(dia, [...grupos, nombre]));
  estado.foco = 'input[name="grupo"]'; // para poder seguir añadiendo
}

function quitarGrupo(grupo) {
  const dia = estado.diaPlan;
  const ejercicios = ejerciciosDe(dia, grupo);
  if (ejercicios.length && !confirm(
    `Quitar «${grupo}» también elimina sus ${ejercicios.length} ejercicio(s) y todo su historial. ¿Continuar?`,
  )) return;

  ejercicios.forEach((e) => tarea(() => DB.eliminarEjercicio(e.id)));
  tarea(() => DB.guardarPlan(dia, gruposDe(dia).filter((g) => g !== grupo)));
}

function anadirEjercicio(grupo, texto) {
  const nombre = capitalizar(texto.trim());
  if (!nombre) return;
  const dia = estado.diaPlan;
  if (ejerciciosDe(dia, grupo).some((e) => e.nombre.toLowerCase() === nombre.toLowerCase())) {
    return aviso("Ese ejercicio ya existe en este grupo", "error");
  }
  tarea(() => DB.crearEjercicio({ dia, grupo, nombre }));
  // Dejamos el cursor en el mismo campo para añadir varios seguidos.
  estado.foco = `form[data-form="ejercicio"][data-grupo="${grupo.replace(/["\\]/g, "\\$&")}"] input`;
}

function borrarEjercicio(id) {
  const e = estado.ejercicios.find((x) => x.id === id);
  if (!e) return;
  const n = registrosDe(id).length;
  const aviso2 = n ? ` Se borrarán también sus ${n} registro(s) de historial.` : "";
  if (confirm(`¿Eliminar «${e.nombre}»?${aviso2}`)) tarea(() => DB.eliminarEjercicio(id));
}

function abrirEditor(id) {
  const e = estado.ejercicios.find((x) => x.id === id);
  if (!e) return;
  const grupos = gruposDe(e.dia).includes(e.grupo) ? gruposDe(e.dia) : [...gruposDe(e.dia), e.grupo];
  modal.innerHTML = `
    <form class="modal-form" data-ej="${e.id}">
      <h3>Editar ejercicio</h3>
      <label>Nombre<input name="nombre" value="${esc(e.nombre)}" maxlength="60" required></label>
      <label>Grupo muscular<select name="grupo">${grupos.map((g) =>
        `<option value="${esc(g)}"${g === e.grupo ? " selected" : ""}>${esc(g)}</option>`).join("")}</select></label>
      <div class="fila-botones">
        <button type="button" class="sec" data-accion="cerrar-modal">Cancelar</button>
        <button class="primario">Guardar</button>
      </div>
    </form>`;
  modal.showModal();
}

/* ====================================================================== */
/*  Temporizador de descanso                                              */
/* ====================================================================== */

// Opciones de descanso, en segundos. Para añadir otra (p. ej. 120), agrégala aquí.
const DURACIONES = [60, 90];

const temporizador = {
  visible: false,
  estado: "elegir",   // "elegir" | "corriendo" | "pausado" | "terminado"
  total: 0,           // duración de la cuenta actual (segundos)
  ultima: 120,         // última duración elegida (se resalta en el selector)
  finMs: 0,           // instante (en ms) en que termina, mientras corre
  restanteMs: 0,      // milisegundos que faltan cuando está en pausa
  reloj: null,        // id del setInterval
};

/*
 * La cuenta NO resta 1 en cada tic: calcula cuánto falta comparando con la hora
 * de fin (finMs). Así sigue siendo exacta aunque el navegador frene el
 * temporizador al cambiar de pestaña.
 */
const msRestantes = () => Math.max(0, temporizador.estado === "corriendo"
  ? temporizador.finMs - Date.now()
  : temporizador.restanteMs);
const mmss = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/* ----- Aviso sonoro y vibración (los navegadores solo permiten sonido tras un toque del usuario) ----- */
let audio;
function prepararAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
  } catch { /* sin audio: seguimos sin sonido */ }
}
function avisarFinDescanso() {
  try {
    if (audio) {
      [0, 0.35, 0.7].forEach((retraso) => { // tres pitidos
        const osc = audio.createOscillator();
        const vol = audio.createGain();
        osc.frequency.value = 880;
        vol.gain.value = 0.25;
        osc.connect(vol);
        vol.connect(audio.destination);
        osc.start(audio.currentTime + retraso);
        osc.stop(audio.currentTime + retraso + 0.2);
      });
    }
    navigator.vibrate?.([200, 100, 200, 100, 400]);
  } catch { /* no es crítico */ }
}

/* ----- Control de la cuenta regresiva ----- */

/** Muestra el panel para elegir 60 / 90 s (se llama al guardar una serie y desde el botón ⏱). */
function ofrecerTemporizador() {
  const t = temporizador;
  t.visible = true;
  // Si ya hay una cuenta en marcha o en pausa, la dejamos como está; si no, mostramos las opciones.
  if (t.estado !== "corriendo" && t.estado !== "pausado") t.estado = "elegir";
  pintarTemporizador();
}

function iniciarTemporizador(segundos) {
  const t = temporizador;
  prepararAudio();
  t.total = t.ultima = segundos;
  t.finMs = Date.now() + segundos * 1000;
  t.estado = "corriendo";
  clearInterval(t.reloj);
  t.reloj = setInterval(tictac, 250);
  pintarTemporizador();
}

function tictac() {
  if (temporizador.estado !== "corriendo") return;
  if (msRestantes() <= 0) terminarTemporizador();
  else actualizarTiempo();
}

function pausarTemporizador() {
  const t = temporizador;
  t.restanteMs = msRestantes();
  t.estado = "pausado";
  clearInterval(t.reloj);
  pintarTemporizador();
}

function reanudarTemporizador() {
  const t = temporizador;
  prepararAudio();
  t.finMs = Date.now() + t.restanteMs;
  t.estado = "corriendo";
  clearInterval(t.reloj);
  t.reloj = setInterval(tictac, 250);
  pintarTemporizador();
}

function terminarTemporizador() {
  const t = temporizador;
  clearInterval(t.reloj);
  t.estado = "terminado";
  t.restanteMs = 0;
  avisarFinDescanso();
  pintarTemporizador();
}

function cerrarTemporizador() {
  const t = temporizador;
  clearInterval(t.reloj);
  t.visible = false;
  t.estado = "elegir";
  pintarTemporizador();
}

/* ----- Dibujado del panel ----- */

/** Solo actualiza el número y la barra (se ejecuta 4 veces por segundo, sin redibujar los botones). */
function actualizarTiempo() {
  const panel = $("#temporizador");
  const ms = msRestantes();
  const tiempo = panel.querySelector(".tmp-tiempo");
  const barra = panel.querySelector(".tmp-barra span");
  if (tiempo) tiempo.textContent = mmss(ms);
  if (barra) barra.style.width = `${Math.min(100, (ms / (temporizador.total * 1000)) * 100)}%`;
}

function pintarTemporizador() {
  const t = temporizador;
  const panel = $("#temporizador");
  panel.hidden = !t.visible;
  document.body.classList.toggle("con-temporizador", t.visible);
  if (!t.visible) return;

  panel.dataset.estado = t.estado;
  const titulo = t.estado === "terminado" ? "⏱ ¡Descanso terminado!" : "⏱ Descanso";
  const cabecera = `<div class="tmp-cab">
      <p class="tmp-titulo"${t.estado === "terminado" ? ' role="alert"' : ""}>${titulo}</p>
      <button type="button" class="tmp-cerrar" data-tmp="cerrar" aria-label="Cerrar temporizador">✕</button>
    </div>`;

  if (t.estado === "elegir") {
    panel.innerHTML = cabecera + `<div class="tmp-opciones">${DURACIONES.map((s) => `
      <button type="button" class="${s === t.ultima ? "primario" : ""}" data-tmp="iniciar" data-seg="${s}">${s} s</button>`).join("")}</div>`;
    return;
  }

  // Botón principal según el estado: Pausar / Reanudar / (si terminó) Cerrar
  const principal = {
    corriendo: `<button type="button" class="primario" data-tmp="pausar">⏸ Pausar</button>`,
    pausado: `<button type="button" class="primario" data-tmp="reanudar">▶ Reanudar</button>`,
    terminado: `<button type="button" class="sec" data-tmp="cerrar">Cerrar</button>`,
  }[t.estado];

  panel.innerHTML = cabecera + `
    <div class="tmp-tiempo" aria-label="Tiempo restante">${mmss(msRestantes())}</div>
    <div class="tmp-barra"><span></span></div>
    <div class="tmp-botones">${principal}<button type="button" data-tmp="reiniciar">↺ Reiniciar</button></div>`;
  actualizarTiempo();
}

function alClicTemporizador(ev) {
  const boton = ev.target.closest("[data-tmp]");
  if (!boton) return;
  switch (boton.dataset.tmp) {
    case "iniciar": iniciarTemporizador(Number(boton.dataset.seg)); break;
    case "pausar": pausarTemporizador(); break;
    case "reanudar": reanudarTemporizador(); break;
    case "reiniciar": iniciarTemporizador(temporizador.total); break; // vuelve a la duración elegida y arranca
    case "cerrar": cerrarTemporizador(); break;
  }
}

/* ====================================================================== */
/*  Datos en vivo y sesión                                                */
/* ====================================================================== */

function suscribir() {
  detener();
  estado.listo = { planes: false, ejercicios: false, registros: false };

  cancelarSuscripciones = [
    DB.observar("planes", (docs) => {
      estado.planes = Object.fromEntries(docs.map((d) => [d.id, d]));
      estado.listo.planes = true;
      render();
    }, alFallar),

    DB.observar("ejercicios", (docs) => {
      estado.ejercicios = docs.sort((a, b) => (a.creado ?? 0) - (b.creado ?? 0));
      estado.listo.ejercicios = true;
      render();
    }, alFallar),

    DB.observar("registros", (docs) => {
      estado.registros = docs.sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.ts ?? 0) - (b.ts ?? 0));
      estado.listo.registros = true;
      render();
    }, alFallar),
  ];
}

function detener() {
  cancelarSuscripciones.forEach((cancelar) => cancelar());
  cancelarSuscripciones = [];
}

function mostrarLogin(mensaje = "", ocultarBoton = false) {
  $("#app").hidden = true;
  $("#pantalla-login").hidden = false;
  $("#login-msg").textContent = mensaje;
  $("#btn-entrar").hidden = ocultarBoton;
}

function mostrarApp(usuario) {
  $("#pantalla-login").hidden = true;
  $("#app").hidden = false;
  $("#usuario").textContent = usuario.displayName || usuario.email || "";
}

function arrancar() {
  $("#btn-entrar").addEventListener("click", () => {
    DB.entrar().catch((err) => $("#login-msg").textContent = `No se pudo iniciar sesión (${err.code || err.message}).`);
  });
  $("#btn-salir").addEventListener("click", () => DB.salir());
  $("#btn-temporizador").addEventListener("click", ofrecerTemporizador);
  $("#temporizador").addEventListener("click", alClicTemporizador);
  $(".tabbar").addEventListener("click", (ev) => {
    const boton = ev.target.closest("[data-vista]");
    if (boton) irA(boton.dataset.vista);
  });

  if (!DB.iniciar()) {
    mostrarLogin("Falta configurar Firebase: pega tus datos en js/firebase-config.js (mira el README).", true);
    return;
  }

  DB.observarSesion((usuario) => {
    if (usuario) {
      mostrarApp(usuario);
      suscribir();
      render();
    } else {
      detener();
      cerrarTemporizador();
      mostrarLogin();
    }
  });
}

arrancar();
