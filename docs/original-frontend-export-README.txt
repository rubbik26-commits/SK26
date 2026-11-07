NYC Dev Intelligence - Front-end Export
=========================================

This package contains the compiled front-end assets for the site
(https://nycremarketintel.com), fetched directly from the live deployment:

- index.html
- assets/index-BbnE3o5g.js   (compiled/minified JS bundle)
- assets/index-shmfCHKD.css  (compiled CSS)
- manifest.webmanifest, icons

IMPORTANT LIMITATIONS
----------------------
1. This is a PRODUCTION BUILD. The JS/CSS are minified and bundled by a build
   tool (Vite). This is NOT the original editable source code (no separate
   .jsx/.tsx/.vue component files, no readable variable names). To get an
   actually editable project, you need the original project repository.

2. The site calls a backend API (e.g. /api/nta-polys and similar endpoints)
   to fetch parcel, zoning, permit, and ownership data. That backend/server
   code and underlying dataset are NOT included here - they cannot be
   accessed from the browser. To open index.html locally and see the map
   shell, you will need to either point it at a running backend or mock
   the API responses.

HOW TO USE IN VS CODE
----------------------
1. Unzip this folder.
2. Open the folder in VS Code.
3. Serve it with a static server (opening index.html directly via file://
   will NOT work correctly because of module scripts and API calls).
   For example, install the "Live Server" extension, or run:
     npx serve .
   in the project folder.
4. Without a backend, map tiles/UI will load but data-dependent features
   (parcel details, scores, permits, etc.) will not populate.
