require('dotenv').config();
const { Telegraf, Markup } = require('telegraf'); 
const axios = require('axios');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// URL de tu Core en Laravel (Laragon)
const LARAVEL_API_URL = 'http://localhost/billar_app/public/api';

// Memoria de sesión temporal expandida
const sesionesActivas = {};

// =========================================================================
// MÓDULO COGNITIVO REVISADO (EXTRACCIÓN FLEXIBLE DE HORA)
// =========================================================================
function extraerHoraTexto(texto) {
    const textoMinuscula = texto.toLowerCase();
    let horaFinal = "20:00:00"; // Por defecto

    const regexHora = /(?:a las\s*)?(\d{1,2})(?::(\d{2}))?(?:\s*y\s*(media|cuarto))?/i;
    const matchHora = textoMinuscula.match(regexHora);

    if (matchHora) {
        let horaBase = parseInt(matchHora[1]);
        let minutos = "00";

        if (matchHora[2]) minutos = matchHora[2];
        if (matchHora[3] === 'media') minutos = "30";
        if (matchHora[3] === 'cuarto') minutos = "15";

        if ((textoMinuscula.includes('noche') || textoMinuscula.includes('tarde') || (horaBase >= 1 && horaBase <= 11)) && !textoMinuscula.includes('mañana')) {
            if (horaBase < 12) {
                horaBase += 12;
            }
        }
        horaFinal = `${horaBase.toString().padStart(2, '0')}:${minutos}:00`;
    }
    return horaFinal;
}

// =========================================================================
// INTERCEPTORES DE ACCIONES CON BOTONES (CALLBACK QUERIES)
// =========================================================================

// 1ra Modificación: El usuario decide que SÍ quiere reservar tras ver las mesas disponibles
bot.action('iniciar_proceso_reserva', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    
    if (!sesionesActivas[chatId] || !sesionesActivas[chatId].mesasDisponibles) {
        return ctx.reply('❌ La sesión ha expirado. Por favor, vuelve a consultar la disponibilidad.');
    }

    await ctx.answerCbQuery();
    
    // Cambiamos el estado de la sesión para esperar la hora de reserva
    sesionesActivas[chatId].estado = 'esperando_hora_reserva';

    await ctx.reply('🕒 *¿A partir de qué hora deseas hacer tu reserva para hoy?*\n\n' +
                    'Ejemplo: Escribe _"a las 7 y media"_, _"19:30"_ o _"a las 8 de la noche"_.', 
                    { parse_mode: 'Markdown' });
});

// Captura la selección de la mesa final tras definir la hora
bot.action(/reservar_mesa_(\d+)/, async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const nombreCliente = ctx.from.first_name || 'Amigo';
    const numeroMesaSeleccionada = ctx.match[1]; 

    if (!sesionesActivas[chatId] || sesionesActivas[chatId].estado !== 'esperando_seleccion_mesa') {
        return ctx.reply('❌ La sesión ha expirado o el flujo es incorrecto.');
    }

    const datos = sesionesActivas[chatId].datos;
    await ctx.answerCbQuery(`Asignando Mesa ${numeroMesaSeleccionada}...`);
    await ctx.reply(`⚡ *Registrando reserva en el sistema central...*`);

    try {
        const response = await axios.post(`${LARAVEL_API_URL}/mesas/reservar`, {
            date: datos.fecha,
            time: datos.hora,
            cliente: nombreCliente,
            mesa_objetivo: numeroMesaSeleccionada 
        });

        if (response.data.exito) {
            // 2do Requisito: Mensaje limpio sin grupo, con hora exacta y advertencia de 10 min
            await ctx.reply(`🎉 *¡Reserva Confirmada Exitosamente!*\n\n` +
                `🎱 *Mesa:* #${numeroMesaSeleccionada}\n` +
                `⏰ *Hora de la reserva:* ${datos.hora.substring(0, 5)}\n\n` +
                `⚠️ *Nota importante:* Tienes un tiempo máximo de tolerancia de 10 minutos para presentarte en el local, caso contrario se cancelará automáticamente tu reserva. ¡Te esperamos!`,
                { parse_mode: 'Markdown' });
        } else {
            await ctx.reply(`❌ *No se pudo guardar:* ${response.data.mensaje}`, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        await ctx.reply('⚠️ _Hubo un problema de escritura en la base de datos de Laravel._', { parse_mode: 'Markdown' });
    }

    delete sesionesActivas[chatId];
});

bot.action('cancelar_reserva', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    await ctx.answerCbQuery('Cancelado');
    await ctx.reply('👍 *Entendido.* Proceso cancelado.');
    delete sesionesActivas[chatId];
});

// =========================================================================
// ESCUCHA DE MENSAJES DE TEXTO PRINCIPAL
// =========================================================================
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const userText = ctx.message.text;
    const textoMinuscula = userText.toLowerCase();
    const nombreCliente = ctx.from.first_name || 'Amigo';

    // --- MANEJO DE FLUJO PASO A PASO (CAPTURA DE HORA) ---
    if (sesionesActivas[chatId] && sesionesActivas[chatId].estado === 'esperando_hora_reserva') {
        const horaExtraida = extraerHoraTexto(userText);
        
        // Guardamos la hora en los datos de la sesión
        sesionesActivas[chatId].datos.hora = horaExtraida;
        sesionesActivas[chatId].estado = 'esperando_seleccion_mesa';

        // Creamos los botones dinámicos usando las mesas que ya sabíamos que estaban libres
        const botonesMesas = sesionesActivas[chatId].mesasDisponibles.map(num => {
            return Markup.button.callback(`🎱 Mesa ${num}`, `reservar_mesa_${num}`);
        });
        botonesMesas.push(Markup.button.callback('❌ Cancelar', 'cancelar_reserva'));

        await ctx.reply(
            `🎯 Perfectamente entendido. Tu reserva se preparará para las *${horaExtraida.substring(0, 5)}*.\n\n` +
            `👉 Ahora, selecciona cuál de las mesas disponibles deseas reservar:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(botonesMesas, { columns: 2 })
            }
        );
        return;
    }

    // --- 3ra Modificación: PRECIOS ACTUALIZADOS (30, 40 y Tiempo Libre) ---
    if (textoMinuscula.includes('precio') || textoMinuscula.includes('cuanto cuesta') || textoMinuscula.includes('costo') || textoMinuscula.includes('tarifa')) {
        await ctx.reply(`💰 *Tarifas Oficiales del Billar Club:*\n\n` +
            `• *Mesa Normal:* 30 Bs la hora.\n` +
            `• *Mesa Match (Profesional):* 40 Bs la hora.\n` +
            `• *Tiempo Libre:* Puedes jugar de forma continua sin límite de tiempo por una tarifa fija especial (Consulta disponibilidad con el administrador en barra).\n\n` +
            `✨ _¡Recuerda que los martes tenemos nuestra promoción de 2x1 en mesas normales!_`, { parse_mode: 'Markdown' });
        return;
    }

    if (textoMinuscula.includes('donde') || textoMinuscula.includes('ubicacion') || textoMinuscula.includes('direccion') || textoMinuscula.includes('horario')) {
        await ctx.reply(`📍 *Ubicación y Horarios:*\n\nEstamos en la zona central de Cochabamba.\n\n⏰ *Horario de Atención:* 15:00 a 23:00`, { parse_mode: 'Markdown' });
        return;
    }

    // --- DETECTOR PRINCIPAL DE DISPONIBILIDAD/RESERVAS ---
    if (
        textoMinuscula.includes('reservar') || textoMinuscula.includes('mesa') ||
        textoMinuscula.includes('reserva') || textoMinuscula.includes('jugar') ||
        textoMinuscula.includes('turno') || textoMinuscula.includes('billar')
    ) {
        
        // Inicializamos datos básicos para el día de hoy
        const fechaFormateada = new Date().toISOString().split('T')[0];
        sesionesActivas[chatId] = { 
            estado: 'viendo_disponibilidad', 
            datos: { fecha: fechaFormateada, hora: "20:00:00", personas: 2 } 
        };

        await ctx.reply(`🤖 _Consultando estado de las mesas en tiempo real..._`, { parse_mode: 'Markdown' });

        try {
            const response = await axios.get(`${LARAVEL_API_URL}/mesas/disponibilidad`, {
                params: { date: fechaFormateada, time: "20:00:00" }
            });

            if (response.data.disponible) {
                // 1ra Modificación: Solo dice qué mesas hay libres y da el botón para iniciar la reserva
                const listaMesasTexto = response.data.mesas.map(num => `• Mesa #${num}`).join('\n');
                
                // Guardamos las mesas libres en la memoria temporal para el siguiente paso
                sesionesActivas[chatId].mesasDisponibles = response.data.mesas;

                await ctx.reply(
                    `🟢 *¡Mesas Disponibles para HOY!*\n\n${listaMesasTexto}\n\n` +
                    `¿Deseas registrar una reserva en este momento?`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            Markup.button.callback('✅ Sí, quiero reservar', 'iniciar_proceso_reserva'),
                            Markup.button.callback('❌ No, gracias', 'cancelar_reserva')
                        ])
                    }
                );
            } else {
                // LÓGICA DE SALA LLENA (SE MANTIENE IGUAL, COMPORTAMIENTO EXCELENTE)
                let horaSugerida = "21:30"; 
                if (response.data && response.data.proxima_hora_libre) {
                    horaSugerida = response.data.proxima_hora_libre.substring(0, 5);
                    sesionesActivas[chatId].datos.hora = response.data.proxima_hora_libre; 
                }

                await ctx.reply(
                    `🔴 *Lo sentimos, en este momento todas las mesas están ocupadas.*\n\n` +
                    `⏱️ Sin embargo, nuestro sistema registra que una de las mesas finalizará su tiempo y se liberará aproximadamente a las *${horaSugerida}*.\n\n` +
                    `⚠️ *Nota importante:* No podemos garantizar que permanezca vacía por mucho tiempo, ya que otros clientes en el local podrían ocuparla inmediatamente al desocuparse.\n\n` +
                    `¿Te gustaría adelantarte y *reservar esta mesa* para que sea tuya apenas se libere a las *${horaSugerida}*? 🎱`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            Markup.button.callback(`✅ Sí, reservar a las ${horaSugerida}`, 'confirmar_reserva'),
                            Markup.button.callback('❌ No, gracias', 'cancelar_reserva')
                        ])
                    }
                );
            }
        } catch (error) {
            await ctx.reply('⚠️ *Error:* No se pudo conectar con el sistema central en Laragon.');
        }
        return;
    }

    // Mensaje de bienvenida por defecto
    await ctx.reply(`👋 *¡Hola, ${nombreCliente}! Bienvenido al Billar Club.*\n\n` +
        `¿Qué deseas hacer hoy? Puedes escribirme de manera directa:\n\n` +
        `🎱 _"Quiero ver las mesas disponibles"_\n` +
        `💰 _"¿Cuánto cuesta la hora de juego?"_`, 
        { parse_mode: 'Markdown' });
});

bot.launch().then(() => {
    console.log('🤖 Módulo SMA local con flujo paso a paso y precios actualizados corriendo.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));