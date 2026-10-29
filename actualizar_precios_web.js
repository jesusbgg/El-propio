const admin = require("firebase-admin");
const { translate } = require('@vitalets/google-translate-api');
const https = require('https');

// Inicializar Firebase con las credenciales secretas de GitHub
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// Función para consultar la web o motores públicos de búsqueda de precios en Brasil
function buscarPrecioEnWeb(terminoBusqueda) {
  return new Promise((resolve) => {
    // Codificamos el término para la URL de búsqueda pública
    const query = encodeURIComponent(terminoBusqueda + " preço RS supermercado");
    const url = `https://html.duckduckgo.com/html/?q=${query}`;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          // Buscamos patrones de precios en Reales (ej: R$ 10,50 o 10.50) dentro del HTML de los resultados
          const regexPrecio = /R\$\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g;
          let match;
          let preciosEncontrados = [];

          while ((match = regexPrecio.exec(data)) !== null) {
            let valorLimpio = match[1].replace('.', '').replace(',', '.');
            let num = parseFloat(valorLimpio);
            // Filtramos para que tengan sentido lógico en el supermercado (entre R$ 1 y R$ 200)
            if (num > 1 && num < 200) {
              preciosEncontrados.push(num);
            }
          }

          if (preciosEncontrados.length > 0) {
            // Retornamos un promedio o el primer precio coherente hallado en la web
            let promedio = preciosEncontrados.reduce((a, b) => a + b, 0) / preciosEncontrados.length;
            resolve(Math.round(promedio * 100) / 100);
          } else {
            resolve(null); // Si no encuentra en la web
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function actualizarPreciosConWeb() {
  console.log("Iniciando búsqueda autónoma de precios en la web...");

  const ref = db.ref('supermercado_data');
  const snapshot = await ref.once('value');
  const data = snapshot.val() || {};

  if (!data.inventario || !Array.isArray(data.inventario)) {
    console.log("No hay inventario registrado en Firebase.");
    process.exit(0);
  }

  for (let item of data.inventario) {
    try {
      // 1. Traducir el producto del español al portugués automáticamente
      const res = await translate(item.nombre, { to: 'pt' });
      const nombrePT = res.text;
      item.sub = nombrePT; // Guardamos la traducción como subtítulo

      console.log(`Buscando en la web para: "${item.nombre}" (Traducido: "${nombrePT}")...`);

      // 2. Buscar el precio real en la web de forma autónoma
      let precioWeb = await buscarPrecioEnWeb(nombrePT);

      if (precioWeb !== null) {
        item.precio = precioWeb;
        console.log(`[ÉXITO] Precio encontrado en la web para ${item.nombre}: R$ ${item.precio}`);
      } else {
        // Fallback dinámico si la web no devuelve un número claro
        if (!item.precio || item.precio === 0) {
          item.precio = 15.00; 
        }
        console.log(`[AVISO] No se halló web directa, usando valor aproximado: R$ ${item.precio}`);
      }

      // Pausa corta para evitar bloqueos por peticiones muy seguidas
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`Error procesando ${item.nombre}:`, err.message);
    }
  }

  // Guardar los resultados en Firebase
  await ref.set(data);
  console.log("¡Base de datos actualizada con los precios extraídos de la web!");
  process.exit(0);
}

actualizarPreciosConWeb().catch(err => {
  console.error("Error crítico:", err);
  process.exit(1);
});
