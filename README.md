# Ranking de billar

Gestión de jugadores, campeonatos, resultados y estadísticas de ranking.

## Abrir la aplicación

Descargá o cloná el repositorio y abrí **index.html** en un navegador moderno. Conservá los archivos y subcarpetas juntos. La aplicación no necesita instalar paquetes para su uso normal. Para probar desde un servidor estático podés usar uno local de tu confianza; usá siempre el mismo origen para conservar acceso a los datos guardados.

## Almacenamiento

Guarda datos y respaldos en localStorage e IndexedDB. Las exportaciones JSON pueden contener nombres y resultados reales.

## Limitaciones

El ranking aplica las reglas implementadas en core.js; no representa una clasificación oficial.

## Desarrollo, privacidad y comprobaciones

Guarda datos y respaldos en localStorage e IndexedDB. Las exportaciones JSON pueden contener nombres y resultados reales.

Los datos del navegador no se suben automáticamente a GitHub. Pueden perderse al borrar el almacenamiento o cambiar de navegador, perfil o dirección. localStorage e IndexedDB no son una bóveda cifrada ni un sistema de cuentas; no ofrecen aislamiento entre aplicaciones del mismo origen. Usá datos ficticios al preparar demos y pruebas. Conservá tus respaldos reales fuera de la carpeta del repositorio o dentro de `private-data/`, `backups/` o `exports/`, que están excluidas de Git. Las capturas privadas van en `private-screenshots/`; las capturas públicas deben revisarse manualmente.

`.gitignore` evita agregados accidentales, pero no elimina archivos ya versionados y se puede omitir con `git add -f`. El control local/CI también rechaza rutas privadas, formatos de respaldo y JSON no previstos. Solo se permiten los JSON de configuración, ejemplos explícitos (`*.example.json`) y fixtures ficticios revisados (`tests/fixtures/*.example.json` o `*.example.csv`). No conviertas datos reales en ejemplos cambiándoles el nombre. Si necesitás otro archivo público legítimo, revisá su contenido y ajustá la lista permitida en `scripts/check-repository.cjs`. El detector usa patrones conocidos: no garantiza detectar todos los secretos ni datos personales en texto o imágenes.

### Comprobar antes de subir

Con **Node.js 24** y **Git**, desde la raíz del repositorio, sin instalar dependencias:

```sh
node scripts/check-repository.cjs --self-test
node scripts/check-repository.cjs
node core.test.js
```

El chequeo básico valida archivos privados, patrones de credenciales, reglas de exclusión, JSON y sintaxis JavaScript, incluidos los scripts dentro de HTML. No abre la interfaz ni demuestra que todas las funciones de la aplicación sean correctas. Las pruebas adicionales usan datos sintéticos y almacenamiento aislado.

### Activar la protección local

Cada clon nuevo debe habilitar el hook explícitamente:

```sh
git config --local core.hooksPath .githooks
```

El hook ejecuta el control antes de crear un commit. Necesita Node.js en PATH; no accede al navegador ni envía datos por red. Podés correr el mismo control manualmente. Antes de cada subida revisá además `git diff --cached` y `git status`. Un detector de CI se ejecuta después de subir: complementa la prevención local, pero no evita una primera exposición. Si se filtra una credencial, revocala/rotala; borrar el archivo o hacer privado el repositorio no invalida las copias previas.

GitHub Actions ejecuta estos controles en cada push y pull request, con permisos de lectura y sin secretos. Las acciones se fijan a commits concretos. No se instala ninguna dependencia de la aplicación durante estas verificaciones.
