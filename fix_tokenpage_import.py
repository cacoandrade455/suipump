import pathlib, sys

target = pathlib.Path("frontend-app/src/TokenPage.jsx")
src = target.read_text(encoding="utf-8")

OLD = "import { PACKAGE_ID, PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, PACKAGE_ID_V7, MIST_PER_SUI, DRAIN_SUI_APPROX, VIRTUAL_SUI_V4, VIRTUAL_SUI_V5, VIRTUAL_SUI_V6, VIRTUAL_SUI_V7, VIRTUAL_TOKENS_V4, VIRTUAL_TOKENS_V5, VIRTUAL_TOKENS_V6, VIRTUAL_TOKENS_V7, DRAIN_SUI_V4, DRAIN_SUI_V5, DRAIN_SUI_V6, DRAIN_SUI_V7, isNewCurve, isV5OrLater, isV7OrLater, supportsMetadataUpdate } from './constants.js';"
NEW = "import { PACKAGE_ID, PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, PACKAGE_ID_V7, PACKAGE_ID_V8, MIST_PER_SUI, DRAIN_SUI_APPROX, VIRTUAL_SUI_V4, VIRTUAL_SUI_V5, VIRTUAL_SUI_V6, VIRTUAL_SUI_V7, VIRTUAL_TOKENS_V4, VIRTUAL_TOKENS_V5, VIRTUAL_TOKENS_V6, VIRTUAL_TOKENS_V7, DRAIN_SUI_V4, DRAIN_SUI_V5, DRAIN_SUI_V6, DRAIN_SUI_V7, isNewCurve, isV5OrLater, isV7OrLater, isV8OrLater, supportsMetadataUpdate } from './constants.js';"

if OLD not in src:
    print("ERROR: import line not found.")
    sys.exit(1)

src = src.replace(OLD, NEW, 1)
target.write_text(src, encoding="utf-8")
print("Done")
