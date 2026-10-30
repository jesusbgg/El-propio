const admin = require('firebase-admin');
const https = require('https');
const translate = require('@vitalets/google-translate-api');

// Inicializar Firebase usando los Secrets de GitHub
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Función para buscar precio web con tiempo controlado (mínimo 5s, máximo 30s)
function buscarPrecioWebControlado(nombreProducto) {
  return new Promise(async (resolve) => {
    console.log(`⏳ Buscando en la web para "${nombreProducto}" (espera entre 5s y 30s max)...`);
    
    const tiempoInicio = Date.now();
    let resuelto = false;

    // Límite máximo de 30 segundos (Timeout de seguridad)
    const timerMaximo = setTimeout(() => {
      if (!resuelto) {
        resuelto = true;
        console.warn(`⚠️ Se alcanzó el tiempo máximo (30s) para ${nombreProducto}. Generando precio dinámico...`);
        let hash = 0;
        for (let i = 0; i < nombreProducto.length; i++) {
          hash = nombreProducto.charCodeAt(i) + ((hash << 5) - hash);
        }
        const precioCalculado = parseFloat((6.50 + (Math.abs(hash) % 3200) / 100).toFixed(2));
        resolve(precioCalculado);
      }
    }, 30000);

    const url = `https://br.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(nombreProducto)}&search_simple=1&action=process&json=1`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', async () => {
        if (resuelto) return;

        let precioEncontrado = null;
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.products && parsed.products.length > 0) {
            for (let p of parsed.products) {
              if (p.price && !isNaN(p.price) && parseFloat(p.price) > 0) {
                precioEncontrado = parseFloat(p.price);
                break;
              }
            }
          }
        } catch (e) {
          // Si falla el parseo, precioEncontrado se mantiene null
        }

        // Garantizar el mínimo de 5 segundos de espera
        const tiempoTranscurrido = Date.now() - tiempoInicio;
        if (tiempoTranscurrido < 5000) {
          await esperar(5000 - tiempoTranscurrido);
        }

        clearTimeout(timerMaximo);
        resuelto = true;

        if (precioEncontrado !== null) {
          resolve(precioEncontrado);
        } else {
          // Generar precio dinámico único si la web no trajo un precio explícito
          let hash = 0;
          for (let i = 0; i < nombreProducto.length; i++) {
            hash = nombreProducto.charCodeAt(i) + ((hash << 5) - hash);
          }
          const precioCalculado = parseFloat((6.50 + (Math.abs(hash) % 3200) / 100).toFixed(2));
          resolve(precioCalculado);
        }
      });
    }).on('error', async () => {
      if (resuelto) return;
      
      const tiempoTranscurrido = Date.now() - tiempoInicio;
      if (tiempoTranscurrido < 5000) {
        await esperar(5000 - tiempoTranscurrido);
      }

      clearTimeout(timerMaximo);
      resuelto = true;

      let hash = 0;
      for (let i = 0; i < nombreProducto.length; i++) {
        hash = nombreProducto.charCodeAt(i) + ((hash << 5) - hash);
      }
      resolve(parseFloat((6.50 + (Math.abs(hash) % 3200) / 100).toFixed(2)));
    });
  });
}

async function actualizarInventario() {
  try {
    console.log('Conectando a Firebase para actualización de inventario...');
    const ref = db.ref('productos');
    const snapshot = await ref.once('value');
    const productos = snapshot.val();

    if (!productos) {
      console.log('No se encontraron productos en la base de datos.');
      process.exit(0);
    }

    for (const id in productos) {
      const producto = productos[id];
      const nombreOriginal = producto.nombre || producto.name;

      if (nombreOriginal) {
        console.log(`\n========================================`);
        console.log(`Procesando: ${nombreOriginal}`);

        // 1. Traducir al portugués de Brasil para el subtítulo (sub)
        try {
          const res = await translate(nombreOriginal, { to: 'pt' });
          producto.sub = res.text;
          console.log(`-> Traducción (pt): ${producto.sub}`);
        } catch (err) {
          console.error(`Error traduciendo ${nombreOriginal}:`, err.message);
        }

        // 2. Buscar precio web (mínimo 5s, máximo 30s)
        const precioFinal = await buscarPrecioWebControlado(nombreOriginal);
        producto.precio = precioFinal;
        console.log(`-> Precio asignado: R$ ${precioFinal}`);
      }
    }

    // Guardar cambios en Firebase
    await ref.set(productos);
    console.log('\n========================================');
    console.log('¡Base de datos actualizada correctamente!');
    process.exit(0);
  } catch (error) {
    console.error('Error general en el script:', error);
    process.exit(1);
  }
}

actualizarInventario();
