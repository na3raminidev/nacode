import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {workspace} from '../src/generator/workspace.js';
import {exportHTML} from '../src/generator/export.js';
const root=path.resolve('test-results/journey-fixture');
const files:Record<string,string>={
 'web/src/page.ts':`import {loadOrders} from './api'; export function openOrders() { return loadOrders(); }`,
 'web/src/api.ts':`export function loadOrders() { return fetch('/orders'); }`,
 'android/OrdersApi.kt':`interface OrdersApi {\n @GET("/orders")\n fun load(): String\n}\n`,
 'android/OrdersViewModel.kt':`class OrdersViewModel(val api: OrdersApi) {\n fun refresh() { api.load() }\n}\n`,
 'api/OrdersController.java':`@RestController class OrdersController { OrdersService service; @GetMapping("/orders") String list() { return service.load(); } }`,
 'api/OrdersService.java':`class OrdersService { OrdersRepository repository; String load() { return repository.findAll(); } }`,
 'api/OrdersRepository.java':`interface OrdersRepository extends JpaRepository<Order, Long> {}`,
 'api/Order.java':`@Entity @Table(name="orders") class Order { Long id; }`,
};
for(const [file,text] of Object.entries(files)){const dest=path.join(root,file);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,text);}
const config={version:1,name:'Order journeys',repositories:[{id:'web',root:'web'},{id:'android',root:'android'},{id:'api',root:'api',service:'orders'}],bindings:[{from:'web',service:'orders'},{from:'android',client:'OrdersApi',service:'orders'}]};
const configPath=path.join(root,'workspace.json');await writeFile(configPath,JSON.stringify(config,null,2));
const out=path.resolve('output/journeys.html');const opts={include:[],exclude:[],ignore:true,out,relationships:'auto' as const};
await exportHTML(await workspace(configPath,opts),out,'snapshot',true,path.resolve('dist/assets'));
console.log(out);


const diff=await workspace(configPath,opts); diff.context=true;diff.comparison='Fixture: orders_archive -> orders';
for(const file of diff.files){const after=files[`${file.repo}/${file.localPath}`];const before=file.path.endsWith('/Order.java')?after.replace('name="orders"','name="orders_archive"'):after;const old=path.join(root,'.before',file.path);await mkdir(path.dirname(old),{recursive:true});await writeFile(old,before);file.before={disk:old,size:Buffer.byteLength(before)};file.status=before===after?'snapshot':'modified';}
await exportHTML(diff,path.resolve('output/journeys-diff.html'),'diff',true,path.resolve('dist/assets'));
