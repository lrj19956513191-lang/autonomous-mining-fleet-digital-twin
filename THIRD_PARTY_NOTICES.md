# Third-party dependencies and notices

This source-only portfolio contains project source, tests, demo data and real application screenshots. It does not vendor node_modules, Python site-packages, Cesium build assets, wheels or dist. This document is not a license grant for the project itself. The project LICENSE remains undecided.

The following metadata and accompanying license texts were inspected in the accepted local environment. Versions identify that environment, not future unpinned installations.

| Dependency | Inspected version | Declared license |
|---|---|---|
| CesiumJS | 1.146.0 | Apache-2.0 |
| @cesium/engine / @cesium/widgets | 26.4.0 / 16.3.0 | Apache-2.0 |
| React / React DOM | 19.3.0 | MIT |
| TypeScript | 7.0.2 | Apache-2.0; includes NOTICE.txt |
| Vite | 8.3.2 | MIT |
| Vitest | 4.1.11 | MIT |
| vite-plugin-static-copy | 3.4.0 | MIT |
| FastAPI | 0.141.1 | MIT |
| Uvicorn | 0.54.0 | BSD-3-Clause |
| Starlette | 1.7.0 | BSD-3-Clause |
| pytest | 9.1.1 | MIT |
| httpx | 0.28.1 | BSD-3-Clause |
| pyproj | 3.7.2 | MIT; installed distribution also includes LICENSE_proj |
| Lightning CSS and optional platform packages | 1.33.0 | MPL-2.0; build tooling |
| DOMPurify | 3.4.16 | MPL-2.0 OR Apache-2.0; Cesium metadata selects Apache-2.0 |

The npm lockfile includes additional MIT, Apache-2.0, BSD-3-Clause, ISC, 0BSD and MIT/Zlib declarations. This is not a blanket MIT license or full legal certification. Build tools and optional platform dependencies are not automatically part of the application's distributed runtime.

## Cesium resources

The inspected Cesium distribution includes LICENSE.md, ThirdParty.json and ThirdParty.extra.json with individual notices. The preview build copies Assets, ThirdParty, Widgets and Workers from the installed distribution. Copied resources are not shipped in this source snapshot; screenshots preserve the actual Cesium on-screen credit.

Before any future distribution of compiled websites, asset bundles, WASM, vendor libraries or Python binary packages, inspect the exact distributed files and include applicable upstream copyright, license and NOTICE texts. Do not relabel all assets MIT. Do not assume every example asset mentioned in Cesium's LICENSE is used by this project. Keep upstream notices and credit.

DEMO_MINE is simulation data, not an operating mine survey or real vehicle telemetry. Application screenshots are genuine Chrome/Cesium captures, not generated artwork.

## References

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), including redistribution and NOTICE requirements.
- [MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/), including its file-level scope.
- [MIT text](https://spdx.org/licenses/MIT.html)
- [BSD-3-Clause text](https://spdx.org/licenses/BSD-3-Clause.html)
- [CesiumJS upstream](https://github.com/CesiumGS/cesium): the installed version and bundled notices identify the inspected dependency set.
- [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
