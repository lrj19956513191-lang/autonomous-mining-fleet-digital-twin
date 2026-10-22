import { afterEach, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ConfigEnv, UserConfig } from 'vite';
const controlled=vi.hoisted(()=>({env:{VITE_BACKEND_ORIGIN:'http://127.0.0.1:9000'} as Record<string,string>,loadEnv:vi.fn(),copy:vi.fn()}));
vi.mock('vite',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('vite')>();
  return {...actual,loadEnv:(mode:string,root:string)=>{controlled.loadEnv(mode,root);return controlled.env;}};
});
vi.mock('vite-plugin-static-copy',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('vite-plugin-static-copy')>();
  return {...actual,viteStaticCopy:(options:Parameters<typeof actual.viteStaticCopy>[0])=>{
    controlled.copy(options);return actual.viteStaticCopy(options);
  }};
});
import config from '../vite.config';
async function evaluate(mode='testing',command:'serve'|'build'='serve'):Promise<UserConfig> {
  const context:ConfigEnv={mode,command};
  return typeof config==='function' ? await config(context) : await config;
}
afterEach(()=>{controlled.env={VITE_BACKEND_ORIGIN:'http://127.0.0.1:9000'};vi.clearAllMocks();});
test('server_and_preview_share_proxy_target',async()=>{
  const result=await evaluate();
  expect(result.server?.proxy?.['/api']).toEqual({target:'http://127.0.0.1:9000',changeOrigin:true});
  expect(result.preview?.proxy?.['/api']).toEqual({target:'http://127.0.0.1:9000',changeOrigin:true});
  expect(result.server).toMatchObject({host:'127.0.0.1',port:5173,strictPort:true});
  expect(result.preview).toMatchObject({host:'127.0.0.1',port:5173,strictPort:true});
  expect(result.base).toBe('/');expect(result.define?.CESIUM_BASE_URL).toBe('"/cesium"');
  expect(result).toMatchObject({test:{environment:'node'}});
  expect(controlled.copy).toHaveBeenCalledWith({targets:[
    {src:'node_modules/cesium/Build/Cesium/ThirdParty',dest:'cesium'},
    {src:'node_modules/cesium/Build/Cesium/Workers',dest:'cesium'},
    {src:'node_modules/cesium/Build/Cesium/Assets',dest:'cesium'},
    {src:'node_modules/cesium/Build/Cesium/Widgets',dest:'cesium'},
  ]});
  expect(result.plugins?.flat().map(p=>p && 'name' in p ? p.name : '')).toContain('vite:react-babel');
});

test.each([
  {VITE_BACKEND_ORIGIN:'file:///tmp'},
  {VITE_BACKEND_ORIGIN:'http://127.0.0.1:9000',VITE_VEHICLE_WS_URL:'ws://127.0.0.1:8000/ws/vehicles'},
])('rejects_config_before_startup %j',async(env)=>{
  controlled.env=env as Record<string,string>;await expect(evaluate()).rejects.toThrow(Error);
});
test.each(['development','production','custom'])('loads_same_mode_from_frontend_root %s',async(mode)=>{
  await evaluate(mode,'build');
  expect(controlled.loadEnv).toHaveBeenCalledWith(mode,fileURLToPath(new URL('../',import.meta.url)));
});
