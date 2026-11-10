# YiuBinance

Bot personal de Telegram para registrar gastos y saber cuánto tienes libre hasta el próximo ingreso. Te avisa como un pata: "hey man, suave" cuando te pasas, "es un buen gusto" cuando vas bien.

## Instalación en el VPS

1. Crea el bot en [@BotFather](https://t.me/BotFather) con `/newbot`.
2. En el VPS, ejecuta `bash /root/suave/setup.sh`.
3. Abre tu bot en Telegram y responde las preguntas iniciales.

El token se guarda en `/root/suave/.env`, con permisos solo para root. El bot no publica puertos.

## IA

Para entender frases libres, audios y capturas, ejecuta `bash /root/suave/setup-ai.sh groq`. Sin clave, el bot funciona igual con los atajos de `ayuda`.

| Orden | Proveedor | Uso |
|---|---|---|
| 1 | Groq `qwen/qwen3.8-27b` | Texto y capturas |
| 2 | Groq `openai/gpt-oss-120b` | Texto |
| 3 | Claude, opcional con `setup-ai.sh claude` | Texto y capturas |
| Aparte | Groq `whisper-large-v3` | Audios |

Cualquier fallo pasa al siguiente proveedor: 404, 429, 5xx, demora o respuesta inválida. `ANTHROPIC_MODEL` cambia el modelo de Claude.

La IA solo propone una lectura. `toCommand` la valida antes de anotar, y una captura solo puede crear gastos o ingresos. El plan gratis de Gemini no se usa porque Google usa ese contenido para mejorar sus productos. En Groq, activa Zero Data Retention en Data Controls.

## Cómo se calcula

```
libre = saldo real − ahorro apartado − meta de ahorro pendiente − fijos del ciclo − apartado para tarjetas
```

- El ciclo va del día de pago semanal al siguiente.
- Los ingresos quincenales solo cuentan cuando los registras.
- El apartado para cada tarjeta crece cada semana hasta cubrir toda la deuda el día en que sale la cuenta. Lo facturado sin pagar y lo que excede la línea se apartan completos.

| Estado | Cuándo |
|---|---|
| Sobrado | Tu ritmo diario disponible supera en más de 25% al de inicio del ciclo |
| Normal | Vas cerca del ritmo |
| Suave | Tu ritmo diario disponible cae más de 25%, o usaste 80% o más de la línea de una tarjeta |
| Alerta | Libre negativo, línea excedida o ingresos seguros insuficientes para pagar una tarjeta |

## Avisos

- Domingo 8 p. m.: resumen y pedido de saldo real.
- 9 a. m.: cuenta emitida, vencimiento en 2 días y el mismo día, y quincena con 4 días de atraso.
- 8 p. m.: 3 días sin registrar.
- 3 a. m.: copia de la base de datos enviada a tu chat, en silencio, si hubo cambios.

## Operación

```bash
docker compose logs -f bot          # ver logs
docker compose up -d --build        # aplicar cambios
bun test                            # correr tests
```

Para restaurar una copia, detén el bot y reemplaza `/data/suave.db` en el volumen `suave_data` por el archivo recibido en Telegram.
