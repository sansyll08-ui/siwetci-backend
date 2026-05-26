const express = require('express');
const cors = require('cors'); 
const app = express();
const { Pool } = require('pg');

// ====================================================================
// CONFIGURACIÓN DE SERVIDOR PARA LA NUBE (RENDER + FIREBASE)
// ====================================================================

// 1. CORS abierto temporalmente para asegurar la comunicación con Firebase
app.use(cors({
    origin: '*', // Permite conexiones de cualquier origen
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'] // Clave para las peticiones con JSON
}));
app.use(express.json());

// 2. Puerto dinámico (Render asignará uno automáticamente, si no, usa el 3001 en local)
const PORT = process.env.PORT || 3001;

// ====================================================================
// 0. CONFIGURACIÓN DE BASE DE DATOS (SUPABASE)
// ====================================================================
const pool = new Pool({
    user: 'postgres.jhidmcagbndgfhomkyrz', 
    password: 'M4rv1n$4nS3020', // Asegúrate de que esta sea tu contraseña real
    host: 'aws-1-us-east-1.pooler.supabase.com', // ¡Cuidado con el 'aws-1'!
    database: 'postgres',
    port: 6543, 
    ssl: {
        rejectUnauthorized: false
    }
});

// Prueba de conexión inmediata para ver qué pasa
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error al conectar al Pooler:', err.stack);
    }
    console.log('¡Conexión exitosa a Supabase vía Pooler!');
    release();
});
let CATALOG_MAP = {};

// ====================================================================
// FUNCIÓN MAESTRA: REINICIAR CONTADOR SERIAL (OPTIMIZACIÓN)
// ====================================================================
const reestablecerSecuencia = async (tabla, columnaId) => {
    try {
        const resSeq = await pool.query(`SELECT pg_get_serial_sequence($1, $2) AS seq_name`, [tabla, columnaId]);
        const seqName = resSeq.rows[0].seq_name;
        if (seqName) {
            // Ajusta el contador al valor máximo real + 1
            await pool.query(`SELECT setval($1, COALESCE((SELECT MAX(${columnaId}) FROM ${tabla}), 0) + 1, false)`, [seqName]);
            console.log(`🔄 Secuencia optimizada: ${tabla} (${columnaId})`);
        }
    } catch (err) { 
        console.error(`⚠️ Error al reajustar secuencia en ${tabla}:`, err.message); 
    }
};

/**
 * CARGA DINÁMICA DE CATÁLOGOS DESDE LA TABLA MAESTRA 'ccatcatal'
 */
const inicializarCatalogos = async () => {
    try {
        const query = `
            SELECT 
                dscatcat AS "dscatcat", 
                nmfisiccat AS "nmfisiccat", 
                nomprikey AS "nomprikey", 
                desprikey AS "desprikey" 
            FROM ccatcatal
        `;
        const res = await pool.query(query);
        CATALOG_MAP = {}; 

        res.rows.forEach(row => {
            // Quitamos la 'c' inicial para el frontend
            const keyFrontend = row.nmfisiccat.startsWith('c') 
                ? row.nmfisiccat.substring(1).toLowerCase() 
                : row.nmfisiccat.toLowerCase();
            
            CATALOG_MAP[keyFrontend] = { 
                table: row.nmfisiccat, 
                idCol: row.nomprikey,
                desCol: row.desprikey,
                nombreVisual: row.dscatcat 
            };
        });
        console.log(`✅ Catálogos cargados en memoria: ${Object.keys(CATALOG_MAP).length}`);
    } catch (error) {
        console.error('❌ ERROR CRÍTICO EN CCATCATAL:', error.message);
    }
};

// PRUEBA DE CONEXIÓN INICIAL
pool.connect().then(() => {
    console.log('✅ Servidor conectado exitosamente a PostgreSQL (Supabase)');
    inicializarCatalogos();
}).catch(err => {
    console.error('❌ Error de conexión a la base de datos:', err.message);
});

/**
 * Lógica de apoyo: Busca una descripción o la inserta si no existe
 */
const getOrInsertId = async (tipo, descripcion) => {
    if (!descripcion || descripcion.trim() === "") return null;
    let config = CATALOG_MAP[tipo.toLowerCase()];
    if (!config) return null;

    try {
        const descOriginal = descripcion.trim();
        const selectQuery = `SELECT ${config.idCol} FROM ${config.table} WHERE LOWER(${config.desCol}) = LOWER($1)`;
        const res = await pool.query(selectQuery, [descOriginal]);

        if (res.rows.length > 0) {
            return res.rows[0][config.idCol];
        } else {
            let query = `INSERT INTO ${config.table} (${config.desCol}) VALUES ($1) RETURNING ${config.idCol}`;
            
            // Defaults para geografía
            if (tipo.includes('estado')) query = `INSERT INTO ${config.table} (${config.desCol}, id_pais) VALUES ($1, 1) RETURNING ${config.idCol}`;
            if (tipo.includes('municipio')) query = `INSERT INTO ${config.table} (${config.desCol}, id_estado) VALUES ($1, 1) RETURNING ${config.idCol}`;
            if (tipo.includes('colonia')) query = `INSERT INTO ${config.table} (${config.desCol}, id_municipio) VALUES ($1, 1) RETURNING ${config.idCol}`;

            const insertRes = await pool.query(query, [descOriginal]);
            const newId = insertRes.rows[0][config.idCol];
            await reestablecerSecuencia(config.table, config.idCol);
            return newId;
        }
    } catch (error) { return null; }
};

// ====================================================================
// 1. API: LOGIN Y CARGA DE DATOS
// ====================================================================

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const query = `
            SELECT u.*, 
            ctp.des_tipo_persona as tipo_persona_name,
            TRIM(CONCAT(cn.des_nombre, ' ', ca1.des_apellido, ' ', ca2.des_apellido)) as full_name,
            COALESCE(json_agg(acc.id_app) FILTER (WHERE acc.id_app IS NOT NULL), '[]') AS permissions
            FROM mUsuarios u
            INNER JOIN mPersona p ON u.id_persona = p.id_persona
            INNER JOIN cTipoPersona ctp ON p.id_tipo_persona = ctp.id_tipo_persona
            LEFT JOIN cNombre cn ON p.id_nombre = cn.id_nombre
            LEFT JOIN cApellido ca1 ON p.id_apellido_pat = ca1.id_apellido
            LEFT JOIN cApellido ca2 ON p.id_apellido_mat = ca2.id_apellido
            LEFT JOIN mAccesos acc ON u.id_usuario = acc.id_usuario
            WHERE u.username = $1 AND u.password = $2
            GROUP BY u.id_usuario, u.username, ctp.des_tipo_persona, cn.des_nombre, ca1.des_apellido, ca2.des_apellido;
        `;

        const result = await pool.query(query, [username, password]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
        }

        const user = result.rows[0];
        const hoy = new Date();
        const fIni = new Date(user.fecha_inicio);
        const fFin = new Date(user.fecha_fin);
        const cuentaActiva = (user.estatus === 'activo' || user.estatus === 'true');

        // REGLAS DE NEGOCIO Y VIGENCIA
        if (!cuentaActiva && hoy < fIni) {
            return res.status(403).json({ success: false, message: "Cuenta desactivada, póngase en contacto con el administrador" });
        }

        if (hoy > fFin) {
            await pool.query('UPDATE mUsuarios SET estatus = $1 WHERE id_usuario = $2', [user.estatus === 'true' ? 'false' : 'inactivo', user.id_usuario]);
            if (!cuentaActiva) return res.status(403).json({ success: false, message: "Cuenta Caducada, póngase en contacto con el administrador" });
            return res.status(403).json({ success: false, message: "Cuenta desabilitada, póngase en contacto con el administrador" });
        }

        if (hoy < fIni) {
            if (!cuentaActiva) return res.status(403).json({ success: false, message: "Cuenta desactivada, póngase en contacto con el administrador" });
            return res.status(403).json({ success: false, message: "Cuenta pendiente por activar" });
        }

        if (!cuentaActiva) {
            return res.status(403).json({ success: false, message: "Cuenta desactivada, póngase en contacto con el administrador" });
        }

        if (cuentaActiva && (hoy >= fIni && hoy <= fFin)) {
            return res.json({ 
                success: true, 
                username: user.username, 
                roleName: user.tipo_persona_name, 
                fullName: user.full_name || user.username, 
                permissions: user.permissions,
                user: { id_usuario: user.id_usuario, login: user.username }
            });
        } else {
            return res.status(403).json({ success: false, message: "Acceso denegado: Su cuenta no está activa para este periodo." });
        }

    } catch (error) {
        console.error("❌ Error en reglas de negocio:", error.message);
        res.status(500).json({ success: false, message: "Error interno en el servidor." });
    }
});

app.get('/api/catalogos', async (req, res) => {
    try {
        let catalogos = {};
        let listaParaSelector = [];
        
        for (const [key, config] of Object.entries(CATALOG_MAP)) {
            try {
                const result = await pool.query(`SELECT ${config.idCol} AS id, ${config.desCol} AS descripcion FROM ${config.table} ORDER BY ${config.desCol} ASC`);
                catalogos[key] = result.rows;
                listaParaSelector.push({ id: key, nombre: config.nombreVisual });
            } catch (innerError) {
                console.error(`❌ Error en catálogo [${key}] (Tabla: ${config.table}):`, innerError.message);
                continue; 
            }
        }
        
        listaParaSelector.sort((a, b) => a.nombre.localeCompare(b.nombre));
        res.json({ success: true, catalogos, listaParaSelector });
    } catch (error) {
        console.error('❌ Error general en /api/catalogos:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ====================================================================
// 2. API: CRUD DINÁMICO DE CATÁLOGOS 
// ====================================================================

app.get('/api/catalogos/verificar-uso/:tipo/:id', async (req, res) => {
    const { tipo, id } = req.params;
    const config = CATALOG_MAP[tipo.toLowerCase()];
    if (!config) return res.status(404).json({ success: false });

    const dependencias = {
        'estado': { tabla: 'mDireccion', fk: 'id_estado' },
        'municipio': { tabla: 'mDireccion', fk: 'id_municipio' },
        'colonia': { tabla: 'mDireccion', fk: 'id_colonia' },
        'calle': { tabla: 'mDireccion', fk: 'id_calle' },
        'marca': { tabla: 'mProducto', fk: 'id_marca' },
        'tipoproducto': { tabla: 'mProducto', fk: 'id_tip_product' },
        'color': { tabla: 'mProducto', fk: 'id_color' },
        'unidadmedida': { tabla: 'mProducto', fk: 'id_unidad' },
        'ubicacion': { tabla: 'mProducto', fk: 'id_ubicacion' },
        'tipopersona': { tabla: 'mPersona', fk: 'id_tipo_persona' },
        'genero': { tabla: 'mPersona', fk: 'id_genero' },
        'nacionalidad': { tabla: 'mPersona', fk: 'id_nacionalidad' },
        'nombre': { tabla: 'mPersona', fk: 'id_nombre' },
        'apellido': { tabla: 'mPersona', fk: 'id_apellido_pat' } 
    };

    const dep = dependencias[tipo.toLowerCase()];
    try {
        if (!dep) return res.json({ success: true, enUso: false });

        if (tipo.toLowerCase() === 'apellido') {
            const result = await pool.query(`SELECT COUNT(*) FROM mPersona WHERE id_apellido_pat = $1 OR id_apellido_mat = $1`, [id]);
            return res.json({ success: true, enUso: parseInt(result.rows[0].count) > 0 });
        }

        const result = await pool.query(`SELECT COUNT(*) FROM ${dep.tabla} WHERE ${dep.fk} = $1`, [id]);
        res.json({ success: true, enUso: parseInt(result.rows[0].count) > 0 });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/catalogos/:tipo', async (req, res) => {
    const config = CATALOG_MAP[req.params.tipo.toLowerCase()];
    try {
        await pool.query(`INSERT INTO ${config.table} (${config.desCol}) VALUES ($1)`, [req.body.descripcion]);
        await reestablecerSecuencia(config.table, config.idCol);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/catalogos/:tipo/:id', async (req, res) => {
    const config = CATALOG_MAP[req.params.tipo.toLowerCase()];
    try {
        await pool.query(`UPDATE ${config.table} SET ${config.desCol} = $1 WHERE ${config.idCol} = $2`, [req.body.descripcion, req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/catalogos/:tipo/:id', async (req, res) => {
    const config = CATALOG_MAP[req.params.tipo.toLowerCase()];
    try {
        await pool.query(`DELETE FROM ${config.table} WHERE ${config.idCol} = $1`, [req.params.id]);
        await reestablecerSecuencia(config.table, config.idCol);
        res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: "Restricción de FK" }); }
});

// ====================================================================
// 3. API: GESTIÓN DE PERSONAS
// ====================================================================

app.get('/api/personas', async (req, res) => {
    try {
        const query = `
            SELECT p.*, tp.des_tipo_persona AS tipo_persona_txt, n.des_nombre AS nombre_txt,
                ap.des_apellido AS ape_pat_txt, am.des_apellido AS ape_mat_txt,
                g.des_genero AS genero_txt, nac.des_nacionalidad AS nacionalidad_txt,
                d.numero, d.codigo_postal, d.referencia_txt,
                calle.des_calle AS calle_txt, col.des_colonia AS colonia_txt,
                mun.des_municipio AS municipio_txt, est.des_estado AS estado_txt, pais.des_pais AS pais_txt
            FROM mPersona p
            LEFT JOIN mDireccion d ON p.id_direccion = d.id_direccion
            LEFT JOIN cTipoPersona tp ON p.id_tipo_persona = tp.id_tipo_persona
            LEFT JOIN cNombre n ON p.id_nombre = n.id_nombre
            LEFT JOIN cApellido ap ON p.id_apellido_pat = ap.id_apellido
            LEFT JOIN cApellido am ON p.id_apellido_mat = am.id_apellido
            LEFT JOIN cGenero g ON p.id_genero = g.id_genero
            LEFT JOIN cNacionalidad nac ON p.id_nacionalidad = nac.id_nacionalidad
            LEFT JOIN cCalle calle ON d.id_calle = calle.id_calle
            LEFT JOIN cColonia col ON d.id_colonia = col.id_colonia
            LEFT JOIN cMunicipio mun ON d.id_municipio = mun.id_municipio
            LEFT JOIN cEstado est ON d.id_estado = est.id_estado
            LEFT JOIN cPais pais ON d.id_pais = pais.id_pais
            ORDER BY p.id_persona ASC`;
        const result = await pool.query(query);
        res.json({ success: true, personas: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/personas', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const d = req.body;
        
        const id_nombre = await getOrInsertId('nombre', d.nombre_txt);
        const id_pat = await getOrInsertId('apellido', d.ape_pat_txt);
        const id_mat = await getOrInsertId('apellido', d.ape_mat_txt);
        const id_calle = await getOrInsertId('calle', d.calle_txt);
        const id_col = await getOrInsertId('colonia', d.colonia_txt);
        const id_mun = await getOrInsertId('municipio', d.municipio_txt);
        const id_est = await getOrInsertId('estado', d.estado_txt);

        const dirRes = await client.query(
            `INSERT INTO mDireccion (id_calle, id_colonia, id_municipio, id_estado, numero, codigo_postal, id_pais, referencia_txt)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id_direccion`,
            [id_calle, id_col, id_mun, id_est, d.numero, d.codigo_postal, d.id_pais || null, d.referencia_txt]
        );
        const id_dir = dirRes.rows[0].id_direccion;

        await client.query(
            `INSERT INTO mPersona (id_tipo_persona, curp, rfc, id_nombre, id_apellido_pat, id_apellido_mat, 
             fecha_nacimiento, id_genero, telefono, email, id_nacionalidad, edad, id_direccion,
             facebook, instagram, tiktok, linkedin, x_twitter, url_web)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
            [d.id_tipo_persona, d.curp, d.rfc, id_nombre, id_pat, id_mat, d.fecha_nacimiento, d.id_genero, d.telefono, d.email, d.id_nacionalidad, d.edad, id_dir, d.facebook, d.instagram, d.tiktok, d.linkedin, d.x_twitter, d.url_web]
        );
        await client.query('COMMIT');
        
        await reestablecerSecuencia('mpersona', 'id_persona');
        await reestablecerSecuencia('mdireccion', 'id_direccion');
        
        res.json({ success: true });
    } catch (err) { 
        await client.query('ROLLBACK'); 
        res.status(500).json({ success: false, message: err.message }); 
    } finally { client.release(); }
});

app.delete('/api/personas/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const perRes = await client.query('SELECT id_direccion FROM mPersona WHERE id_persona = $1', [req.params.id]);
        const id_dir = perRes.rows[0]?.id_direccion;
        await client.query('BEGIN');
        await client.query('DELETE FROM mPersona WHERE id_persona = $1', [req.params.id]);
        if (id_dir) await client.query('DELETE FROM mDireccion WHERE id_direccion = $1', [id_dir]);
        await client.query('COMMIT');
        
        await reestablecerSecuencia('mpersona', 'id_persona');
        if (id_dir) await reestablecerSecuencia('mdireccion', 'id_direccion');
        
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false });
    } finally { client.release(); }
});

// ====================================================================
// 4. API: GESTIÓN DE PRODUCTOS E INVENTARIO
// ====================================================================

app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM v_productos_detallados ORDER BY id_producto ASC`);
        res.json({ success: true, productos: result.rows });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/productos', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const p = req.body;
        const id_marca = await getOrInsertId('marca', p.marca_txt);
        const id_tip_product = await getOrInsertId('tipoproducto', p.tipo_product_txt);
        const id_color = await getOrInsertId('color', p.color_txt);
        const id_unidad = await getOrInsertId('unidadmedida', p.unidad_medida_txt);
        const id_ubicacion = await getOrInsertId('ubicacion', p.ubicacion_txt);

        const query = `INSERT INTO mproducto (clave_producto, codigo_interno, nombre, tamano, id_unidad, imagen_url, cant_exist, stock_min, stock_max, id_ubicacion, p_costo, p_venta, fec_caducidad, id_marca, id_tip_product, id_color, id_proveedor, id_estatus) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id_producto`;
        const values = [p.clave_producto, p.codigo_interno || null, p.nombre, p.tamano, id_unidad, p.imagen_url || null, p.cant_exist || 0, p.stock_min || 5, p.stock_max || 100, id_ubicacion, p.p_costo, p.p_venta, p.fec_caducidad || null, id_marca, id_tip_product, id_color, p.id_proveedor, p.id_estatus || 1];

        const result = await client.query(query, values);
        await client.query('COMMIT');
        await reestablecerSecuencia('mproducto', 'id_producto');
        res.json({ success: true, id: result.rows[0].id_producto });
    } catch (err) { 
        await client.query('ROLLBACK'); 
        res.status(500).json({ success: false }); 
    } finally { client.release(); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM mproducto WHERE id_producto = $1`, [req.params.id]);
        await reestablecerSecuencia('mproducto', 'id_producto');
        res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false }); }
});

// ====================================================================
// 5. API: APLICACIONES, ACCESOS Y MANTENIMIENTO DE USUARIOS
// ====================================================================

app.get('/api/aplicaciones', async (req, res) => {
    try {
        const result = await pool.query('SELECT id_app as clave, nombre_app as descripcion FROM mAplicaciones ORDER BY id_app');
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/aplicaciones/save', async (req, res) => {
    const { clave, descripcion, esNueva } = req.body;
    try {
        if (esNueva) {
            await pool.query('INSERT INTO mAplicaciones (id_app, nombre_app) VALUES ($1, $2)', [clave, descripcion]);
        } else {
            await pool.query('UPDATE mAplicaciones SET nombre_app = $2 WHERE id_app = $1', [clave, descripcion]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "La clave ya existe o datos inválidos" }); }
});

app.delete('/api/aplicaciones/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const check = await pool.query('SELECT * FROM mAcceRol WHERE id_app = $1', [id]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: "La aplicación o módulo actual no puede ser eliminada, por estar asignada a una cuenta" });
        }
        await pool.query('DELETE FROM mAplicaciones WHERE id_app = $1', [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/usuarios-disponibles', async (req, res) => {
    try {
        const result = await pool.query('SELECT id_usuario as id, username as name FROM mUsuarios WHERE estatus = $1', ['activo']);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/asignar-privilegios', async (req, res) => {
    const { usuarios, aplicaciones } = req.body; 
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        for (const userId of usuarios) {
            await client.query('DELETE FROM mAccesos WHERE CvUser = $1', [userId]);
            for (const appId of aplicaciones) {
                await client.query('INSERT INTO mAccesos (CvUser, CvAplicacion) VALUES ($1, $2)', [userId, appId]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true, message: "Privilegios asignados correctamente" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/usuarios', async (req, res) => {
    try {
        const query = `
            SELECT u.id_usuario, u.id_persona, u.username as login, u.password, 
                   u.fecha_inicio as fecini, u.fecha_fin as fecfin, u.estatus as edocta,
                   TRIM(CONCAT(n.des_nombre, ' ', ap.des_apellido, ' ', am.des_apellido)) as nombre_completo
            FROM mUsuarios u
            INNER JOIN mPersona p ON u.id_persona = p.id_persona
            LEFT JOIN cNombre n ON p.id_nombre = n.id_nombre
            LEFT JOIN cApellido ap ON p.id_apellido_pat = ap.id_apellido
            LEFT JOIN cApellido am ON p.id_apellido_mat = am.id_apellido
            ORDER BY u.id_usuario ASC`;
        const result = await pool.query(query);
        res.json({ success: true, usuarios: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/personas/seleccion', async (req, res) => {
    try {
        const query = `
            SELECT p.id_persona, 
                   TRIM(CONCAT(n.des_nombre, ' ', ap.des_apellido, ' ', am.des_apellido)) as nombre_completo
            FROM mpersona p
            INNER JOIN cNombre n ON p.id_nombre = n.id_nombre
            INNER JOIN cApellido ap ON p.id_apellido_pat = ap.id_apellido
            LEFT JOIN cApellido am ON p.id_apellido_mat = am.id_apellido
            ORDER BY nombre_completo ASC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/usuarios/gestion', async (req, res) => {
    const { id_usuario, id_persona, login, password, fecini, fecfin, edocta, modo } = req.body;
    
    try {
        const check = await pool.query(
            'SELECT id_usuario FROM mUsuarios WHERE (username = $1 OR password = $2) AND id_usuario != $3', 
            [login, password, id_usuario || 0]
        );

        if (check.rows.length > 0) {
            return res.json({ success: false, message: "El Login o Password ya pertenecen a otra cuenta." });
        }

        if (modo === 'NUEVO') {
            const query = `INSERT INTO mUsuarios (id_persona, username, password, fecha_inicio, fecha_fin, estatus) VALUES ($1, $2, $3, $4, $5, $6)`;
            await pool.query(query, [id_persona, login, password, fecini, fecfin, edocta]);
        } else {
            const query = `UPDATE mUsuarios SET id_persona = $1, username = $2, password = $3, fecha_inicio = $4, fecha_fin = $5, estatus = $6 WHERE id_usuario = $7`;
            await pool.query(query, [id_persona, login, password, fecini, fecfin, edocta, id_usuario]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error interno del servidor." });
    }
});

app.get('/api/usuarios/check-accesos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT COUNT(*) FROM mAccesos WHERE CvUser = $1', [id]);
        res.json({ hasAccesos: parseInt(result.rows[0].count) > 0 });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/usuarios/:id/validar-borrado', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query("SELECT COUNT(*) FROM maccesos WHERE id_usuario = $1", [id]);
        res.json({ tieneAccesos: parseInt(result.rows[0].count) > 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM mUsuarios WHERE id_usuario = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al eliminar el registro." });
    }
});

app.put('/api/usuarios/cambiar-password', async (req, res) => {
    const { username, oldPass, newPass } = req.body;
    try {
        const checkUser = await pool.query('SELECT password FROM mUsuarios WHERE username = $1', [username]);

        if (checkUser.rows[0].password !== oldPass) {
            return res.status(400).json({ success: false, message: "Cambio de Password Inconcluso, póngase en contacto con el administrador o reintentelo." });
        }

        const checkDuplicate = await pool.query('SELECT username FROM mUsuarios WHERE password = $1', [newPass]);

        if (checkDuplicate.rows.length > 0) {
            return res.status(400).json({ success: false, message: "Cambio de Password Inconcluso, póngase en contacto con el administrador o reintentelo." });
        }

        await pool.query('UPDATE mUsuarios SET password = $1 WHERE username = $2', [newPass, username]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error interno del servidor." });
    }
});

app.post('/api/usuarios/cambiar-password', async (req, res) => {
    const { id_usuario, newPassword } = req.body;
    try {
        const check = await pool.query('SELECT id_usuario FROM mUsuarios WHERE password = $1 AND id_usuario != $2', [newPassword, id_usuario]);
        if (check.rows.length > 0) {
            return res.json({ success: false, message: "Este password ya ha sido utilizado. Elige otro." });
        }
        await pool.query('UPDATE mUsuarios SET password = $1 WHERE id_usuario = $2', [newPassword, id_usuario]);
        res.json({ success: true, message: "Contraseña actualizada con éxito." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error al cambiar la contraseña." });
    }
});

// ====================================================================
// 6. API: ESTADÍSTICAS PARA EL DASHBOARD
// ====================================================================

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        // 1. KPIs Financieros
        const v = await pool.query("SELECT COALESCE(SUM(total_venta), 0) as total FROM mventas WHERE id_estatus = 1");
        const c = await pool.query("SELECT COALESCE(SUM(total_compra), 0) as total FROM mcompras");
        const p = await pool.query("SELECT COUNT(*) as total FROM mpedidos WHERE id_estatus_pedido = 1");
        const s = await pool.query("SELECT COUNT(*) as total FROM mproducto WHERE cant_exist <= stock_min");

        // 2. Cartera de Proveedores (LO QUE FALTA)
        // Unimos mcompras con mpersona para obtener los nombres de los proveedores
        const topProv = await pool.query(`
            SELECT
                TRIM(CONCAT(cn.des_nombre, ' ', ca1.des_apellido, ' ', ca2.des_apellido)) as proveedor, 
                SUM(mc.total_compra) as total
            FROM mcompras mc
            INNER JOIN mpersona p ON mc.id_proveedor = p.id_persona
            LEFT JOIN cNombre cn ON p.id_nombre = cn.id_nombre
            LEFT JOIN cApellido ca1 ON p.id_apellido_pat = ca1.id_apellido
            LEFT JOIN cApellido ca2 ON p.id_apellido_mat = ca2.id_apellido
            GROUP BY proveedor 
            ORDER BY total DESC 
            LIMIT 5
        `);

        // 3. Fidelidad de Clientes (mventas -> mpersona vía id_cliente)
        const topClientes = await pool.query(`
            SELECT 
                TRIM(CONCAT(cn.des_nombre, ' ', ca1.des_apellido, ' ', ca2.des_apellido)) as cliente, 
                SUM(mv.total_venta) as total
            FROM mventas mv
            INNER JOIN mpersona p ON mv.id_cliente = p.id_persona
            LEFT JOIN cNombre cn ON p.id_nombre = cn.id_nombre
            LEFT JOIN cApellido ca1 ON p.id_apellido_pat = ca1.id_apellido
            LEFT JOIN cApellido ca2 ON p.id_apellido_mat = ca2.id_apellido
            WHERE mv.id_estatus = 1
            GROUP BY cliente ORDER BY total DESC LIMIT 5
        `);

        // 4. Artículos Estrella (Basado en dventas)
        const topArticulos = await pool.query(`
            SELECT pr.nombre, SUM(dv.cantidad) as total_vendido
            FROM dventas dv
            JOIN mproducto pr ON dv.id_producto = pr.id_producto
            GROUP BY pr.nombre ORDER BY total_vendido DESC LIMIT 5
        `);
        // 1. Tendencia Semanal
const tendencia = await pool.query(`
    SELECT 
        to_char(fec_venta::date, 'DD/MM') as fecha, 
        SUM(total_venta)::float as total,
        fec_venta::date as dia
    FROM mventas
    WHERE fec_venta >= (CURRENT_DATE - INTERVAL '7 days')
      AND id_estatus = 1
    GROUP BY fec_venta::date
    ORDER BY dia ASC
`);

// 2. Mix de Ventas por Categoría (Suponiendo tabla cTipoProducto)
const categorias = await pool.query(`
    SELECT tp.des_tipo_producto as categoria, SUM(dv.subtotal) as total
    FROM dventas dv
    JOIN mproducto p ON dv.id_producto = p.id_producto
    JOIN ctipoproducto tp ON p.id_tip_product = tp.id_tipo_producto
    GROUP BY categoria
    ORDER BY total DESC
`);

// 3. Eficiencia de Stock (Productos más vendidos vs su existencia actual)
const stockEficiencia = await pool.query(`
    SELECT nombre, cant_exist, stock_min
    FROM mproducto
    WHERE cant_exist <= (stock_min * 1.5) -- Productos cerca del límite
    LIMIT 5
`);

        // 5. Inventario y Listados
        const inventarioInfo = await pool.query("SELECT nombre, cant_exist, stock_max FROM mproducto ORDER BY cant_exist ASC LIMIT 5");
        const nuevos = await pool.query("SELECT nombre, p_venta FROM mproducto ORDER BY fec_registro DESC LIMIT 5");

        // 👇 AQUÍ ESTÁ LA SOLUCIÓN: Agregamos tendencia, categorias y stockEficiencia
        res.json({
            success: true,
            ventas: parseFloat(v.rows[0].total),
            compras: parseFloat(c.rows[0].total),
            pedidos: parseInt(p.rows[0].total),
            alertaStock: parseInt(s.rows[0].total),
            utilidad: parseFloat(v.rows[0].total) - parseFloat(c.rows[0].total),
            topClientes: topClientes.rows,
            topProveedores: topProv.rows,
            topArticulos: topArticulos.rows,
            inventario: inventarioInfo.rows,
            nuevos: nuevos.rows,
            // Variables añadidas para que el Dashboard las pueda leer:
            tendencia: tendencia.rows,
            categorias: categorias.rows,
            stockEficiencia: stockEficiencia.rows
        });

    } catch (error) {
        console.error("❌ Error en Dashboard API:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ====================================================================
// 7. API: CORTE DE CAJA
// ====================================================================

app.get('/api/corte/resumen', async (req, res) => {
    try {
        const efectivoRes = await pool.query(`SELECT COALESCE(SUM(total_venta), 0) as total FROM mventas WHERE DATE(fec_venta) = CURRENT_DATE AND id_estatus = 1`);
        const tarjetaRes = await pool.query(`SELECT COALESCE(SUM(total_venta), 0) as total FROM mventas WHERE DATE(fec_venta) = CURRENT_DATE AND id_estatus = 2`);
        const transfRes = await pool.query(`SELECT COALESCE(SUM(total_venta), 0) as total FROM mventas WHERE DATE(fec_venta) = CURRENT_DATE AND id_estatus = 3`);

        const fondoCaja = 500.00; 
        const salidasDinero = 0.00; 

        res.json({
            success: true,
            fondoCaja: fondoCaja,
            ventasEfectivo: parseFloat(efectivoRes.rows[0].total),
            ventasTarjeta: parseFloat(tarjetaRes.rows[0].total),
            ventasTransferencia: parseFloat(transfRes.rows[0].total),
            salidasDinero: salidasDinero
        });
    } catch (error) {
        console.error("Error en resumen de corte:", error);
        res.status(500).json({ success: false, message: 'Error al consultar la base de datos.' });
    }
});

app.post('/api/corte/finalizar', async (req, res) => {
    const { id_usuario, fondoCaja, ventasEfectivo, totalEsperado, efectivoReal, diferencia, observaciones } = req.body;
    try {
        const query = `
            INSERT INTO mcortes (
                id_usuario, fecha_corte, fondo_caja, ventas_efectivo, 
                total_esperado, efectivo_real, diferencia, observaciones
            ) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7)
        `;
        await pool.query(query, [id_usuario, fondoCaja, ventasEfectivo, totalEsperado, efectivoReal, diferencia, observaciones]);
        res.json({ success: true, message: '¡Corte de caja guardado con éxito!' });
    } catch (error) {
        console.error("Error al guardar corte:", error);
        res.status(500).json({ success: false, message: 'No se pudo registrar el corte en la base de datos.' });
    }
});


// Buscar producto por nombre, clave o código interno
app.get('/api/productos/buscar/:busqueda', async (req, res) => {
    const { busqueda } = req.params;

    try {
        const query = `
            SELECT 
                id_producto AS id,
                clave_producto,
                codigo_interno,
                nombre,
                p_venta AS precio_venta,
                cant_exist
            FROM mproducto
            WHERE 
                LOWER(nombre) LIKE LOWER($1)
                OR LOWER(clave_producto) LIKE LOWER($1)
                OR LOWER(COALESCE(codigo_interno, '')) LIKE LOWER($1)
            ORDER BY nombre ASC
            LIMIT 10
        `;

        const result = await pool.query(query, [`%${busqueda}%`]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error buscando productos:', error.message);
        res.status(500).json([]);
    }
});
app.post('/api/ventas/registrar', async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const { cliente, items, metodo_pago, estado } = req.body;

        if (!items || !items.item || items.item.length === 0) {
            return res.json({
                success: false,
                message: 'La venta no contiene productos.'
            });
        }

        let idMetodoPago = null;

        if (metodo_pago === 'efectivo') idMetodoPago = 1;
        if (metodo_pago === 'tarjeta') idMetodoPago = 2;
        if (metodo_pago === 'transferencia') idMetodoPago = 4;

        const estadoVenta = estado || 'completada';

        let totalVenta = 0;

        for (const item of items.item) {
            totalVenta += Number(item.cantidad) * Number(item.precio_unitario);
        }

        const ventaResult = await client.query(
            `
            INSERT INTO mventas (
                fec_venta,
                total_venta,
                id_usuario_atiende,
                id_estatus,
                id_cliente,
                cliente_nombre,
                id_metodo_pago,
                estado_venta
            )
            VALUES (
                CURRENT_TIMESTAMP,
                $1,
                $2,
                $3,
                NULL,
                $4,
                $5,
                $6
            )
            RETURNING id_venta
            `,
            [
                totalVenta,
                1,
                1,
                cliente || 'Mostrador',
                idMetodoPago,
                estadoVenta
            ]
        );

        const idVenta = ventaResult.rows[0].id_venta;

        for (const item of items.item) {
            const subtotal = Number(item.cantidad) * Number(item.precio_unitario);

            await client.query(
                `
                INSERT INTO dventas (
                    id_venta,
                    id_producto,
                    cantidad,
                    precio_unitario,
                    subtotal
                )
                VALUES ($1, $2, $3, $4, $5)
                `,
                [
                    idVenta,
                    item.producto_id,
                    item.cantidad,
                    item.precio_unitario,
                    subtotal
                ]
            );

            if (estadoVenta === 'completada') {
                await client.query(
                    `
                    UPDATE mproducto
                    SET cant_exist = cant_exist - $1
                    WHERE id_producto = $2
                    `,
                    [item.cantidad, item.producto_id]
                );
            }
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            venta: {
                id: idVenta,
                total: totalVenta
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error registrando venta:', error.message);

        res.status(500).json({
            success: false,
            message: 'Error al registrar la venta.'
        });
    } finally {
        client.release();
    }
});
app.get('/api/ventas/espera', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id_venta AS id,
                COALESCE(cliente_nombre, 'Mostrador') AS cliente,
                TO_CHAR(fec_venta, 'YYYY-MM-DD') AS fecha,
                TO_CHAR(fec_venta, 'HH24:MI') AS hora,
                total_venta AS total
            FROM mventas
            WHERE estado_venta = 'en_espera'
            ORDER BY fec_venta DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Error obteniendo ventas en espera:', error.message);
        res.status(500).json([]);
    }
});


// ============================================================
// BUSCAR VENTA POR ID / TICKET
// ESTA RUTA VA DESPUÉS
// ============================================================
app.get('/api/ventas/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const ventaResult = await pool.query(`
            SELECT 
                id_venta AS id,
                fec_venta,
                COALESCE(cliente_nombre, 'Mostrador') AS cliente,
                total_venta AS total,
                estado_venta
            FROM mventas
            WHERE id_venta = $1
        `, [id]);

        if (ventaResult.rows.length === 0) {
            return res.json({
                success: false,
                message: 'Venta no encontrada.'
            });
        }

        const detalleResult = await pool.query(`
            SELECT 
                dv.id_detalle_v,
                dv.id_producto,
                p.nombre,
                p.clave_producto,
                p.codigo_interno,
                p.cant_exist,
                dv.cantidad,
                dv.precio_unitario,
                dv.subtotal
            FROM dventas dv
            INNER JOIN mproducto p ON dv.id_producto = p.id_producto
            WHERE dv.id_venta = $1
            ORDER BY dv.id_detalle_v ASC
        `, [id]);

        const venta = ventaResult.rows[0];
        venta.detalles = detalleResult.rows;

        res.json({
            success: true,
            venta
        });

    } catch (error) {
        console.error('Error buscando venta:', error.message);

        res.status(500).json({
            success: false,
            message: 'Error al buscar la venta.'
        });
    }
});

app.get('/api/devoluciones', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id_devolucion,
                id_venta,
                fecha_devolucion,
                motivo,
                total_devolucion
            FROM mdevoluciones
            ORDER BY fecha_devolucion DESC
            LIMIT 20
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Error obteniendo devoluciones:', error.message);
        res.status(500).json([]);
    }
});

app.post('/api/devoluciones/registrar', async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const { id_venta, motivo } = req.body;

        const ventaResult = await client.query(`
            SELECT id_venta, total_venta, estado_venta
            FROM mventas
            WHERE id_venta = $1
        `, [id_venta]);

        if (ventaResult.rows.length === 0) {
            throw new Error('La venta no existe.');
        }

        const venta = ventaResult.rows[0];

        if (venta.estado_venta === 'devuelta') {
            throw new Error('Esta venta ya fue devuelta anteriormente.');
        }

        const detallesResult = await client.query(`
            SELECT id_producto, cantidad, precio_unitario, subtotal
            FROM dventas
            WHERE id_venta = $1
        `, [id_venta]);

        const devolucionResult = await client.query(`
            INSERT INTO mdevoluciones (
                id_venta,
                motivo,
                total_devolucion,
                id_usuario
            )
            VALUES ($1, $2, $3, $4)
            RETURNING id_devolucion
        `, [
            id_venta,
            motivo || 'Devolución registrada desde POS',
            venta.total_venta,
            1
        ]);

        const idDevolucion = devolucionResult.rows[0].id_devolucion;

        for (const item of detallesResult.rows) {
            await client.query(`
                INSERT INTO ddevoluciones (
                    id_devolucion,
                    id_producto,
                    cantidad,
                    precio_unitario,
                    subtotal
                )
                VALUES ($1, $2, $3, $4, $5)
            `, [
                idDevolucion,
                item.id_producto,
                item.cantidad,
                item.precio_unitario,
                item.subtotal
            ]);

            await client.query(`
                UPDATE mproducto
                SET cant_exist = cant_exist + $1
                WHERE id_producto = $2
            `, [
                item.cantidad,
                item.id_producto
            ]);
        }

        await client.query(`
            UPDATE mventas
            SET estado_venta = 'devuelta'
            WHERE id_venta = $1
        `, [id_venta]);

        await client.query('COMMIT');

        res.json({
            success: true,
            id_devolucion: idDevolucion,
            message: 'Devolución registrada correctamente.'
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('Error registrando devolución:', error.message);

        res.status(500).json({
            success: false,
            message: error.message
        });
    } finally {
        client.release();
    }
});


// ============================================================
// API: FACTURAS
// ============================================================

app.get('/api/facturas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id_factura,
                id_venta,
                fecha_factura,
                rfc_cliente,
                razon_social,
                total_factura,
                estado_factura
            FROM mfacturas
            ORDER BY fecha_factura DESC
            LIMIT 20
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Error obteniendo facturas:', error.message);
        res.status(500).json([]);
    }
});

app.post('/api/facturas/registrar', async (req, res) => {
    try {
        const {
            id_venta,
            rfc_cliente,
            razon_social,
            uso_cfdi,
            regimen_fiscal,
            total_factura
        } = req.body;

        const ventaResult = await pool.query(`
            SELECT id_venta, total_venta
            FROM mventas
            WHERE id_venta = $1
        `, [id_venta]);

        if (ventaResult.rows.length === 0) {
            return res.json({
                success: false,
                message: 'La venta no existe.'
            });
        }

        const venta = ventaResult.rows[0];

        const facturaResult = await pool.query(`
            INSERT INTO mfacturas (
                id_venta,
                rfc_cliente,
                razon_social,
                uso_cfdi,
                regimen_fiscal,
                total_factura,
                estado_factura
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'generada')
            RETURNING id_factura
        `, [
            id_venta,
            rfc_cliente || null,
            razon_social || null,
            uso_cfdi || null,
            regimen_fiscal || null,
            total_factura || venta.total_venta
        ]);

        res.json({
            success: true,
            id_factura: facturaResult.rows[0].id_factura,
            message: 'Factura generada correctamente.'
        });

    } catch (error) {
        console.error('Error generando factura:', error.message);

        res.status(500).json({
            success: false,
            message: 'Error al generar factura.'
        });
    }
});


app.put('/api/productos/:id', async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const { id } = req.params;
        const p = req.body;

        const id_marca = await getOrInsertId('marca', p.marca_txt);
        const id_tip_product = await getOrInsertId('tipoproducto', p.tipo_product_txt);
        const id_color = await getOrInsertId('color', p.color_txt);
        const id_unidad = await getOrInsertId('unidadmedida', p.unidad_medida_txt);
        const id_ubicacion = await getOrInsertId('ubicacion', p.ubicacion_txt);

        const existeCodigo = await client.query(
            `
            SELECT id_producto
            FROM mproducto
            WHERE codigo_interno = $1
              AND id_producto != $2
            `,
            [p.codigo_interno, id]
        );

        if (existeCodigo.rows.length > 0) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                success: false,
                message: 'El código interno ya pertenece a otro producto.'
            });
        }

        await client.query(
            `
            UPDATE mproducto
            SET 
                clave_producto = $1,
                codigo_interno = $2,
                nombre = $3,
                tamano = $4,
                id_unidad = $5,
                imagen_url = $6,
                cant_exist = $7,
                stock_min = $8,
                stock_max = $9,
                id_ubicacion = $10,
                p_costo = $11,
                p_venta = $12,
                fec_caducidad = $13,
                id_marca = $14,
                id_tip_product = $15,
                id_color = $16,
                id_proveedor = $17,
                id_estatus = $18,
                fec_modificacion = CURRENT_TIMESTAMP
            WHERE id_producto = $19
            `,
            [
                p.clave_producto,
                p.codigo_interno || p.clave_producto,
                p.nombre,
                p.tamano || null,
                id_unidad,
                p.imagen_url || null,
                p.cant_exist || 0,
                p.stock_min || 5,
                p.stock_max || 100,
                id_ubicacion,
                p.p_costo || 0,
                p.p_venta || 0,
                p.fec_caducidad || null,
                id_marca,
                id_tip_product,
                id_color,
                p.id_proveedor || null,
                p.id_estatus || 1,
                id
            ]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Producto actualizado correctamente.'
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('Error actualizando producto:', error.message);

        res.status(500).json({
            success: false,
            message: error.message || 'Error al actualizar el producto.'
        });
    } finally {
        client.release();
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor SiWeTCI (Papelería Yanina) activo en el puerto ${PORT}`);
});
