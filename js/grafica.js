/**
 * grafica.js — Gráfica de líneas en SVG, sin librerías externas.
 *
 * Recibe una lista de puntos [{ x: "20 oct", y: 62.5 }, …] (uno por sesión,
 * en orden cronológico) y devuelve el SVG como texto listo para insertar en la página.
 * Los colores salen del CSS (clases .g-*), así que cambian con el tema.
 */

const ANCHO = 420;
const ALTO = 240;
const M = { arriba: 28, derecha: 18, abajo: 32, izquierda: 44 }; // márgenes internos

/** Formatea un valor del eje: con decimales solo si el rango es pequeño. */
function formatear(v, rango) {
  return String(Number(v.toFixed(rango < 10 ? 1 : 0)));
}

/**
 * @param {{x: string, y: number}[]} puntos
 * @param {string} unidad  texto que acompaña al último valor (p. ej. "kg")
 * @returns {string} SVG
 */
export function dibujarGrafica(puntos, unidad = "") {
  const n = puntos.length;
  if (n === 0) return "";

  const anchoUtil = ANCHO - M.izquierda - M.derecha;
  const altoUtil = ALTO - M.arriba - M.abajo;

  // Rango vertical con un margen del 15 % para que la línea no pegue con los bordes.
  const ys = puntos.map((p) => p.y);
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  if (min === max) { min -= 1; max += 1; }
  const holgura = (max - min) * 0.15;
  min = Math.max(0, min - holgura);
  max += holgura;
  const rango = max - min;

  const px = (i) => (n === 1 ? M.izquierda + anchoUtil / 2 : M.izquierda + (anchoUtil * i) / (n - 1));
  const py = (v) => M.arriba + altoUtil * (1 - (v - min) / rango);

  // Rejilla horizontal con 4 marcas en el eje Y
  let rejilla = "";
  for (let i = 0; i < 4; i++) {
    const v = min + (rango * i) / 3;
    const y = py(v).toFixed(1);
    rejilla += `<line class="g-rejilla" x1="${M.izquierda}" x2="${ANCHO - M.derecha}" y1="${y}" y2="${y}"/>`
      + `<text class="g-texto" x="${M.izquierda - 8}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${formatear(v, rango)}</text>`;
  }

  // Etiquetas del eje X: máximo 5, repartidas de forma pareja (siempre la primera y la última)
  const marcas = Math.min(n, 5);
  const indices = new Set();
  for (let i = 0; i < marcas; i++) indices.add(Math.round((i * (n - 1)) / (marcas - 1 || 1)));
  let etiquetasX = "";
  for (const i of indices) {
    // Primera etiqueta alineada a la izquierda y última a la derecha, para que no se salgan del SVG.
    const ancla = n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle";
    const x = ancla === "start" ? px(i) - 10 : px(i);
    etiquetasX += `<text class="g-texto" x="${x.toFixed(1)}" y="${ALTO - 8}" text-anchor="${ancla}">${puntos[i].x}</text>`;
  }

  // Línea, área bajo la línea y puntos
  const coords = puntos.map((p, i) => `${px(i).toFixed(1)},${py(p.y).toFixed(1)}`);
  const base = (M.arriba + altoUtil).toFixed(1);
  const linea = n > 1 ? `<polyline class="g-linea" points="${coords.join(" ")}"/>` : "";
  const area = n > 1
    ? `<polygon class="g-area" points="${px(0).toFixed(1)},${base} ${coords.join(" ")} ${px(n - 1).toFixed(1)},${base}"/>`
    : "";
  const circulos = puntos
    .map((p, i) => `<circle class="g-punto${i === n - 1 ? " ultimo" : ""}" cx="${px(i).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${i === n - 1 ? 5 : 4}"/>`)
    .join("");

  // Valor del último punto, escrito encima
  const ult = puntos[n - 1];
  const valor = `<text class="g-valor" x="${Math.min(px(n - 1), ANCHO - M.derecha).toFixed(1)}" y="${(py(ult.y) - 12).toFixed(1)}" text-anchor="${n > 1 ? "end" : "middle"}">${Math.round(ult.y * 100) / 100}${unidad ? " " + unidad : ""}</text>`;

  const descripcion = `Gráfica de progresión: de ${puntos[0].y} a ${ult.y} ${unidad} en ${n} sesiones`;
  return `<svg viewBox="0 0 ${ANCHO} ${ALTO}" role="img" aria-label="${descripcion}" xmlns="http://www.w3.org/2000/svg">`
    + rejilla + area + linea + circulos + valor + etiquetasX + `</svg>`;
}
