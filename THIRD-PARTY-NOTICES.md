# Third-party notices

PhotoStream itself is released under the MIT License; see [LICENSE](./LICENSE).

This file lists the third-party components that are **distributed with the
packaged Windows build**, with their versions, licenses and copyright lines.
It also explains how the LGPL-3.0 obligation for libvips is met, because that is
the only component whose license is not permissive.

Full license texts live in [`licenses/`](./licenses):

| File | License |
|------|---------|
| [MIT.txt](./licenses/MIT.txt) | MIT |
| [Apache-2.0.txt](./licenses/Apache-2.0.txt) | Apache License 2.0 |
| [LGPL-3.0.txt](./licenses/LGPL-3.0.txt) | GNU Lesser General Public License 3.0 |

## Shipped with the application

| Component | Version | License | Copyright notice |
|-----------|---------|---------|------------------|
| Electron | 44.9.0 | MIT | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. |
| Chromium | 152.0.7977.167 | BSD-3-Clause and others | See `LICENSES.chromium.html` in the application root |
| Node.js | 24.x (bundled with Electron) | MIT | Copyright Node.js contributors; Copyright (c) Joyent, Inc. and other Node contributors |
| sharp | 0.35.5 | Apache-2.0 | Copyright 2013 Lovell Fuller and others |
| libvips | 8.18.7 | LGPL-3.0-or-later | Copyright (c) 1990-2026 Kirk Martinez and contributors; Copyright (c) 2005-2026 John Cupitt and contributors |
| @img/sharp-win32-x64 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Copyright 2013 Lovell Fuller and others; libvips copyright as above |
| exif-reader | 2.0.3 | MIT | Copyright (c) 2015 Devon Govett and others |
| React | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| React DOM | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| scheduler | 0.28.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| image-size | 2.0.4 | MIT | Copyright (c) 2013-Present Aditya Yadav |

`exif-reader` and `sharp` are loaded from `node_modules` at runtime (they are
kept outside the ASAR bundle). `image-size` is compiled into `out/main/index.js`.
React, React DOM and `scheduler` are compiled into the renderer bundle.

Electron ships its own `LICENSE` and `LICENSES.chromium.html` at the root of the
packaged application. Those files are kept verbatim and cover Electron, Chromium
and the bundled Node.js runtime.

## libvips (LGPL-3.0-or-later)

libvips is the only copyleft component in the application. It is used through
`sharp`, which only exposes it as a dynamically loaded library.

**How it is linked.** The Windows build ships `libvips-42.dll` and
`libvips-cpp-8.18.7.dll` as separate DLLs under
`resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/`. The ASAR
unpack rule in `scripts/package.mjs` deliberately keeps that directory outside
the archive, so the library is not embedded in the application bundle.

**Replacing the library.** Because libvips is a separate DLL, a user can replace
it with another ABI-compatible build by substituting those two files. No source
code of PhotoStream needs to be modified or relinked to do so.

**Corresponding source.** The exact version in this build is libvips 8.18.7:

- libvips source: <https://github.com/libvips/libvips/tree/v8.18.7>
- The Windows binaries are produced by the sharp project; its build scripts and
  dependency versions are at <https://github.com/lovell/sharp>

If you received a binary build and need the corresponding source on physical
media, open an issue at <https://github.com/sico-sico/PhotoStream/issues> and it
will be provided.

**License text.** A copy of LGPL-3.0 is included at
[licenses/LGPL-3.0.txt](./licenses/LGPL-3.0.txt). Copyright and license notices
for libvips are preserved in this file because the upstream binary package does
not ship its own `COPYING` file.

## Build-time only, not distributed

The following are used to build and test the application and are **not** present
in the packaged build. They are listed because their licenses still matter when
the source repository is redistributed:

- Vite, electron-vite, TypeScript, Vitest, Playwright, Testing Library — MIT
- esbuild — MIT
- lightningcss — MPL-2.0
- caniuse-lite — CC-BY-4.0
- Electron's `@electron/packager` — BSD-2-Clause

`caniuse-lite` data is used only to build the browser-target list; its attribution
requirement applies to redistribution of that data, which the packaged
application does not do.

## Keeping this file accurate

Versions above match `package-lock.json`. When a dependency that ships in the
packaged build is upgraded, update its row here and re-check
`licenses/` for any newly required text.

This file is a factual inventory, not legal advice. Distribution obligations
should be reviewed by counsel before shipping a build.
