// Synthetic source only: input applications are never executed.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { workspace } from '../src/generator/workspace.js';
import { exportHTML } from '../src/generator/export.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'graphicode-insights-demo-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-c', 'user.name=Demo', '-c', 'user.email=demo@example.test', ...args], { windowsHide: true, encoding: 'utf8' }).trim();
const files: Record<string, string> = {
 'web/orders/OrderPage.tsx': `import {OrderCard} from './OrderCard';\nimport {loadOrders} from './api';\nexport function OrderPage() {\n dispatch(Orders.Load);\n const orders = loadOrders();\n return <OrderCard orders={orders}/>;\n}\nexport function returnFromPayment() { navigate('Orders'); }\n// SCN-orders-payment\nconst scenario = 'SCN-orders-payment';\nconst paymentError = 'GCS-AP-015';`,
 'web/orders/OrderCard.tsx': 'export function OrderCard(props: unknown) { return <article>Order</article>; }',
 'web/orders/api.ts': "export function loadOrders() { return fetch('/orders'); }",
 'web/orders/OrderDto.ts': 'export interface OrderDto { amount: number; currency: string; }',
 'web/orders/orders.test.ts': "import {loadOrders} from './api';\nconst scenario = 'SCN-orders-payment';\nfunction testOrders() { return loadOrders(); }",
 'web/orders/state.ts': "export function reduce(action: unknown) {\n switch (action) { case Orders.Load: return 'loading'; }\n}\nconst error = 'GCS-AP-015';",
 'android/orders/OrdersApi.kt': 'interface OrdersApi {\n @GET("/orders")\n fun load(): String\n}',
 'android/orders/OrdersScreen.kt': '@Composable\nfun OrdersScreen() { BonButton() }\nfun refresh() { sendAction(Orders.Load) }',
 'api/orders/OrdersController.java': '@RestController\nclass OrdersController { OrdersService service;\n @GetMapping("/orders")\n String list() { return service.load(); }\n}',
 'api/orders/OrdersService.java': 'class OrdersService { OrdersRepository repository;\n @Transactional\n String load() { return repository.findAll(); }\n @Scheduled\n void recover() { claimForConfirm(); repository.save(null); }\n void claimForConfirm() {}\n}',
 'api/orders/PaymentCallback.java': 'class PaymentCallback { OrdersRepository repository;\n @Transactional\n void callback() { repository.save(null); }\n}',
 'api/orders/OrdersRepository.java': 'interface OrdersRepository extends JpaRepository<Order, Long> {}',
 'api/orders/Order.java': '@Entity @Table(name="orders") class Order { Long id; }',
 'config/orders.yaml': 'orders:\n  enabled: false\n  minimumVersion: 4',
 'db/orders.sql': 'ALTER TABLE orders ADD COLUMN payment_status VARCHAR(32);',
 'docs/OrdersFlow.md': '# Orders payment\n\nSCN-orders-payment\n\n1. Open orders.\n2. Return from payment and revalidate state.\n\n[Screen](../web/orders/OrderPage.tsx)\n[Test](../web/orders/orders.test.ts)',
};
const configPath = path.join(root, 'workspace.json');
const config = {version:1,name:'Orders / ten evidence lenses',repositories:[{id:'demo',root:'.',service:'orders'}],bindings:[{from:'demo',client:'fetch',service:'orders'},{from:'demo',client:'OrdersApi',service:'orders'}],features:[{id:'orders',label:'Orders & payment',include:['**/orders/**','**/OrdersFlow.md','config/orders.yaml','db/orders.sql']}]};
try {
 for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root,file)),{recursive:true}); await writeFile(path.join(root,file),text); }
 await writeFile(configPath, JSON.stringify(config)); git('init','-b','main'); git('add','.'); git('commit','-m','Orders: web, Android, API and scenario baseline');
 const base=git('rev-parse','HEAD'); git('branch','release-demo');
 await writeFile(path.join(root,'web/orders/OrderDto.ts'),'export interface OrderDto { amount?: number; currency: string; status: string; }');
 await writeFile(path.join(root,'web/orders/OrderCard.tsx'),'export function OrderCard(props: unknown) { return <article>Payment status</article>; }');
 git('add','.'); git('commit','-m','Orders: optional amount and shared card payment status');
 const opts={include:[],exclude:['workspace.json'],ignore:true,out:'',relationships:'auto' as const};
 const snapshot=await workspace(configPath,opts); snapshot.history={limit:100,refs:['release-demo']};
 await exportHTML(snapshot,path.resolve('output/insights.html'),'snapshot',true,path.resolve('dist/assets'));
 await writeFile(configPath,JSON.stringify({...config,repositories:[{...config.repositories[0],base,head:'HEAD'}]}));
 const diff=await workspace(configPath,opts); diff.history={limit:100,refs:['release-demo']};
 await exportHTML(diff,path.resolve('output/insights-diff.html'),'diff',true,path.resolve('dist/assets'));
 console.log('Created output/insights.html and output/insights-diff.html (synthetic fixtures only).');
} finally { await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250}); }
