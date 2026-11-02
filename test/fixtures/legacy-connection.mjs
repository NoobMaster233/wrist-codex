// Page tests exercise existing RPC/view state independently of the transport.
// The private event/file adapter has its own integration tests.
import {utf8Length} from '../../band/src/common/private-connection.mjs';
import {shellPresets,shellSummary} from '../../band/src/common/device-tools.mjs';
import {createNativeEventBus} from '../../band/src/common/native-event-bus.mjs';
export const pageConnectionDependencies={utf8Length,file:{},shellPresets,shellSummary,createNativeEventBus,
  createBandConnection:({legacy})=>Object.assign(typeof legacy==='function'?legacy():legacy,{show(){},hide(){},destroy(){}})};
