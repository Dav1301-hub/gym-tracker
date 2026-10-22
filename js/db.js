/**
 * db.js — Capa de datos.
 *
 * Todo lo que habla con Firebase (inicio de sesión + base de datos Firestore)
 * vive en este archivo. El resto de la app (app.js) solo usa estas funciones,
 * así que si algún día cambias de base de datos, solo tocas este archivo.
 *
 * Estructura en Firestore (todo cuelga del usuario, así cada persona ve solo lo suyo):
 *
 *   usuarios/{uid}/planes/{dia}      → { grupos: ["Pecho", "Tríceps"] }
 *                                      ({dia} = lunes … domingo)
 *   usuarios/{uid}/ejercicios/{id}   → { dia, grupo, nombre, creado }
 *   usuarios/{uid}/registros/{id}    → { ejercicioId, fecha, peso, reps, series, ts }
 *                                      (fecha = "AAAA-MM-DD", peso en kg)
 *
 * Funciona sin conexión: Firestore guarda una copia local y sincroniza
 * automáticamente cuando vuelve internet.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, query, where, writeBatch,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

let auth = null; // servicio de autenticación
let db = null;   // servicio de Firestore
let uid = null;  // id del usuario con sesión iniciada

/** ¿El usuario ya pegó su configuración de Firebase? */
export function configurado() {
  return !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PEGA_");
}

/** Inicializa Firebase. Devuelve false si falta configurar. */
export function iniciar() {
  if (!configurado()) return false;
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Caché local persistente: la app sigue funcionando sin señal en el gimnasio.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  return true;
}

/* ------------------------------ Sesión ------------------------------ */

/** Avisa cuando el usuario inicia o cierra sesión. cb(usuario | null) */
export function observarSesion(cb) {
  return onAuthStateChanged(auth, (usuario) => {
    uid = usuario ? usuario.uid : null;
    cb(usuario);
  });
}

/** Inicia sesión con Google (ventana emergente; si el navegador la bloquea, redirección). */
export async function entrar() {
  const proveedor = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, proveedor);
  } catch (err) {
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, proveedor);
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      throw err;
    }
  }
}

export const salir = () => signOut(auth);

/* ----------------------------- Utilidades ---------------------------- */

const coleccion = (nombre) => collection(db, "usuarios", uid, nombre);
const documento = (nombre, id) => doc(db, "usuarios", uid, nombre, id);

/**
 * Escucha una colección EN TIEMPO REAL: cb(lista) se llama al cargar y cada vez
 * que algo cambia (incluso desde otro dispositivo). Devuelve la función para dejar de escuchar.
 */
export function observar(nombre, cb, alError) {
  return onSnapshot(
    coleccion(nombre),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    alError,
  );
}

/* ------------------------------- Planes ------------------------------ */

/** Guarda (o reemplaza) los grupos musculares de un día. */
export function guardarPlan(dia, grupos) {
  return setDoc(documento("planes", dia), { grupos });
}

/* ----------------------------- Ejercicios ---------------------------- */

export function crearEjercicio({ dia, grupo, nombre }) {
  return addDoc(coleccion("ejercicios"), { dia, grupo, nombre, creado: Date.now() });
}

export function editarEjercicio(id, cambios) {
  return updateDoc(documento("ejercicios", id), cambios);
}

/** Elimina un ejercicio Y todo su historial de registros. */
export async function eliminarEjercicio(id) {
  const registros = await getDocs(query(coleccion("registros"), where("ejercicioId", "==", id)));
  // Firestore permite máx. 500 operaciones por lote → borramos en bloques de 400.
  const refs = registros.docs.map((d) => d.ref);
  for (let i = 0; i < refs.length; i += 400) {
    const lote = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => lote.delete(r));
    await lote.commit();
  }
  await deleteDoc(documento("ejercicios", id));
}

/* ----------------------------- Registros ----------------------------- */

export function crearRegistro({ ejercicioId, fecha, peso, reps, series }) {
  return addDoc(coleccion("registros"), { ejercicioId, fecha, peso, reps, series, ts: Date.now() });
}

export function eliminarRegistro(id) {
  return deleteDoc(documento("registros", id));
}
