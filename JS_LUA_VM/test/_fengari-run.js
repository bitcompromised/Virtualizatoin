// Test helper: execute a Lua file using the pure-JS fengari interpreter.
const fs = require('fs');
const { lua, lauxlib, lualib, to_luastring } = require('fengari');
const src = fs.readFileSync(process.argv[2], 'utf8');
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
if (lauxlib.luaL_dostring(L, to_luastring(src)) !== lua.LUA_OK) {
  console.error('LUA ERROR:', lua.lua_tojsstring(L, -1));
  process.exit(1);
}
