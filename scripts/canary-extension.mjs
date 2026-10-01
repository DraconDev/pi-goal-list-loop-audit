/** Source for the disposable canary child. Pi catches request-hook errors,
 * so rejection must terminate this child synchronously before dispatch. */
export function buildCanaryExtensionSource({ maxUsd, receipt, outcome }) {
  return `import fs from 'node:fs';
    import {createCanaryBudget} from ${JSON.stringify(new URL('./canary-budget.mjs', import.meta.url).href)};
    export default function(pi) {
      const guard=createCanaryBudget({maxUsd:${JSON.stringify(maxUsd)},maxOutputTokens:32,maxPayloadBytes:8192});
      let attempts=0, requests=0;
      pi.on('before_provider_request',(event,ctx)=>{
        attempts++;
        try {
          const capped=guard(event.payload,ctx.model);
          fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({provider:ctx.model?.provider,model:ctx.model?.id,priceMetadata:ctx.model?.cost,maxOutputTokens:32,maxPayloadBytes:8192,attempts,requests:requests+1,refused:false}));
          requests++;
          return capped;
        } catch(error) {
          try { fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({attempts,requests,refused:true,reason:String(error?.message??error)})); } catch {}
          // Dedicated child only. Neither a swallowed hook error nor a
          // failed refusal-receipt write may permit the original payload.
          process.exit(78);
        }
      });
      pi.on('agent_end',event=>{
        const last=event.messages?.filter(message=>message.role==='assistant').at(-1);
        const text=(last?.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('').trim();
        fs.writeFileSync(${JSON.stringify(outcome)},JSON.stringify({matched:text==='GLLA_CANARY_OK',usage:last?.usage,stopReason:last?.stopReason}));
      });
    }`;
}
