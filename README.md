# 💪 Fuerza — Registro de entrenamiento y sobrecarga progresiva

Aplicación web personal, *mobile-first*, para planificar tu semana de entrenamiento, registrar peso / repeticiones / series de cada ejercicio y ver tu progresión con el tiempo. Funciona en móvil, tablet y computador, y tus datos se sincronizan entre todos tus dispositivos.

## Decisiones técnicas (y por qué)

| Decisión | Elección | Motivo |
|---|---|---|
| Front-end | **HTML + CSS + JavaScript puro** (módulos ES) | Sin Node, sin compilar, sin dependencias. Se edita y se publica tal cual. React/Vue serían excesivos para 3 pantallas. |
| Almacenamiento | **Firebase** (Auth con Google + Firestore) | Es la opción más simple que cumple "acceder desde cualquier dispositivo": sin servidor propio, plan gratuito de sobra, y funciona sin conexión (se sincroniza al volver la señal). `localStorage` no sirve: los datos quedarían atados a un solo navegador. |
| Hosting | **GitHub Pages** | Gratis, se despliega con solo hacer `git push`. |
| Gráfica | SVG propio (`js/grafica.js`, ~80 líneas) | Evita cargar una librería de gráficos. |

## Estructura de archivos

```
gym-tracker/
├── index.html              Página única: contiene las 3 vistas (se pintan desde JS)
├── manifest.webmanifest    Permite "instalarla" en la pantalla de inicio
├── firestore.rules         Reglas de seguridad: cada usuario solo ve lo suyo
├── css/
│   └── styles.css          Estilos mobile-first (+ ajustes para ≥600px y ≥900px)
├── js/
│   ├── firebase-config.js  ← AQUÍ pegas los datos de tu proyecto Firebase
│   ├── db.js               Toda la comunicación con Firebase (login + base de datos)
│   ├── app.js              Interfaz y lógica: vistas Hoy / Plan / Progreso
│   └── grafica.js          Gráfica de líneas en SVG
└── icons/                  Iconos de la app
```

## Modelo de datos (Firestore)

```
usuarios/{uid}/planes/{dia}      { grupos: ["Pecho", "Tríceps"] }     dia = lunes … domingo
usuarios/{uid}/ejercicios/{id}   { dia, grupo, nombre, creado }
usuarios/{uid}/registros/{id}    { ejercicioId, fecha, peso, reps, series, ts }
```

## Puesta en marcha

### 1. Crear el proyecto en Firebase (≈5 min, gratis)

1. Entra a <https://console.firebase.google.com> → **Agregar proyecto** (puedes desactivar Google Analytics).
2. **Authentication** → *Comenzar* → pestaña *Sign-in method* → activa **Google**.
3. **Firestore Database** → *Crear base de datos* → modo **producción** → elige una región cercana.
4. En Firestore, pestaña **Reglas**: pega el contenido de `firestore.rules` y pulsa *Publicar*.
5. **Configuración del proyecto** (⚙️) → *Tus apps* → icono **</>** (Web) → registra la app → copia el objeto `firebaseConfig`.
6. Pégalo en `js/firebase-config.js`, reemplazando los valores de ejemplo.

> Los valores de `firebaseConfig` no son secretos; lo que protege tus datos son las reglas del paso 4. Es seguro subirlos a GitHub.

### 2. Probar en tu computador

Los módulos ES requieren un servidor (no abras `index.html` con doble clic):

```bash
cd gym-tracker
python3 -m http.server 8000
```

Abre <http://localhost:8000>. `localhost` ya viene autorizado en Firebase para el inicio de sesión.

### 3. Subir a GitHub

```bash
cd gym-tracker
git init -b main            # (ya está hecho si recibiste la carpeta con .git)
git add .
git commit -m "Primera versión de la app de entrenamiento"

# Con la CLI de GitHub:
gh repo create gym-tracker --public --source=. --push
# …o crea el repositorio vacío en github.com y luego:
# git remote add origin https://github.com/TU-USUARIO/gym-tracker.git
# git push -u origin main
<!--  -->

### 4. Publicarla con GitHub Pages

1. En el repositorio: **Settings → Pages → Build and deployment**.
2. *Source*: **Deploy from a branch** → rama `main`, carpeta `/ (root)` → *Save*.
3. En un minuto tendrás la URL: `https://TU-USUARIO.github.io/gym-tracker/`.
4. **Importante:** en Firebase → *Authentication → Settings → Dominios autorizados* → **Agregar dominio** → `TU-USUARIO.github.io`. Sin esto, el botón "Entrar con Google" fallará en la web publicada.

Cada `git push` a `main` actualiza la app automáticamente.

### 5. Instalarla en el móvil (opcional)

- **Android (Chrome):** menú ⋮ → *Instalar aplicación* / *Añadir a pantalla de inicio*.
- **iPhone (Safari):** botón Compartir → *Añadir a pantalla de inicio*.

## Cómo se usa

1. **Plan:** elige un día (Lun–Dom), añade los grupos musculares que entrenas (Pecho, Espalda…) y, dentro de cada grupo, sus ejercicios. Con ✎ editas un ejercicio (nombre o grupo) y con 🗑 lo eliminas. Todo se guarda al instante.
2. **Hoy:** se abre en el día actual. Cada ejercicio muestra tu sesión anterior como referencia y trae los campos ya rellenos con tu último registro; ajusta con **−/+** (peso de 2,5 en 2,5 kg) y toca **Guardar sesión**. Lo guardado hoy aparece debajo y puede borrarse con ✕.
3. **Progreso:** elige un ejercicio para ver la gráfica de **peso máximo** o de **volumen total** (peso × reps × series) por sesión, tus estadísticas (actual, mejor, cambio) y el historial completo.

## Notas

- **Eliminar un ejercicio o quitar un grupo borra también su historial** (la app pide confirmación).
- **Sin conexión:** Firestore guarda una copia local y sincroniza al volver la señal. Para que la página abra sin internet por primera vez en un dispositivo, hay que haberla cargado antes una vez con conexión.
- **Mejoras opcionales:** un *service worker* para abrir la app 100 % offline, exportar el historial a CSV, notas por sesión o un temporizador de descanso.
