# Agente Pronósticos MAV — Guía de instalación

Agente que cada mañana revisa los partidos del día del Mundial 2026, investiga
contexto (lesiones, forma, clima) y te envía a Telegram los picks 1/X/2 para tus
tres formularios (Sello, Solsticio, Disruptivo), según el protocolo MAV.

**Importante:** el agente NO envía nada al Google Forms. Solo prepara y propone.
Tú revisas en Telegram y confirmas con un clic en el Forms antes de cada pitazo.

---

## Estructura de archivos

```
agente-pronosticos-mav/
├── .github/workflows/revision-diaria.yml   ← programa la corrida diaria (7 AM COL)
├── src/agente.py                           ← script principal
└── src/protocolo_mav.md                    ← nuestro protocolo (lineamientos)
```

## Requisitos previos (ya los tienes)
- Repo privado `agente-pronosticos-mav` en GitHub.
- 3 secretos cargados en Settings → Secrets and variables → Actions:
  - `ANTHROPIC_API_KEY`
  - `TELEGRAM_TOKEN`
  - `TELEGRAM_CHAT_ID`

## Pasos para instalar (por la web de GitHub, sin comandos)

1. En tu repo `agente-pronosticos-mav`, clic en **Add file → Upload files**.
2. Sube los archivos respetando las carpetas. La forma más simple por web:
   - Sube `agente.py` y `protocolo_mav.md`. Antes de confirmar, en el nombre del
     archivo escribe `src/agente.py` y `src/protocolo_mav.md` (GitHub crea la
     carpeta `src/` automáticamente al poner la barra).
   - Para el workflow: sube `revision-diaria.yml` y nómbralo
     `.github/workflows/revision-diaria.yml`.
   - (Si te resulta más fácil, puedes arrastrar las carpetas completas).
3. Escribe un mensaje de commit (ej. "agente inicial") y **Commit changes**.

## Probar que funciona (sin esperar a mañana)

1. En el repo, ve a la pestaña **Actions**.
2. Selecciona el workflow **"Revisión diaria MAV"**.
3. Clic en **Run workflow** → **Run workflow** (botón verde).
4. Espera ~1-2 minutos. Si todo está bien, te llega un mensaje a Telegram con
   los picks del día (o un aviso de que hoy no hay partidos).
5. Si algo falla, abre la corrida en Actions y revisa el log del paso
   "Generar y enviar picks" para ver el error.

## Horario

Corre a las **12:00 UTC = 7:00 AM Colombia** todos los días. Para cambiar la
hora, edita la línea `cron: "0 12 * * *"` en el workflow (el primer número es
minutos, el segundo es la hora UTC; recuerda Colombia = UTC-5).

Nota: GitHub Actions a veces arranca las tareas programadas con algunos minutos
de retraso. Para los días con partidos muy temprano, puedes correrlo a mano con
"Run workflow" cuando quieras.

## Costo

Cada corrida consume unos centavos de dólar de tu crédito de Anthropic. Con un
límite de USD 5-10/mes te sobra de largo.

## Mantenimiento

- Si cambian los lineamientos, edita `src/protocolo_mav.md` y haz commit.
- El modelo por defecto es `claude-sonnet-4-6`. Para cambiarlo, agrega un secreto
  o variable `MAV_MODEL` con otro identificador de modelo.
