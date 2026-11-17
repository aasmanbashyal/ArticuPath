import { modelReady, state } from './state.js';
import { $, notifyError, toast } from './ui.js';
import { modelsHTML } from './models-view.js';
import { api } from './api.js';
import { refreshTranscript } from './review.js';

function createModelManager({ updateChrome }) {
  let modelPoll;

  function applyModelState(payload) {
    state.app={...state.app,...payload}; updateChrome();
    if(state.view==='settings') {
      const list=$('#models'), focused=document.activeElement;
      const asr=focused?.name==='asr' ? focused.value : null;
      const refreshing=focused?.dataset.action==='refresh-models';
      if(list) list.innerHTML=modelsHTML();
      if(asr) $(`input[name="asr"][value="${asr}"]`)?.focus({preventScroll:true});
      if(refreshing) $('[data-action="refresh-models"]')?.focus({preventScroll:true});
    }
    if(state.app.download && state.app.download.stage!=='error' && !modelPoll) {
      modelPoll=setInterval(async()=>{
        try {
          const modelState=await api('/models');
          applyModelState(modelState);
          if(!modelState.download || modelState.download.stage==='error') {
            clearInterval(modelPoll); modelPoll=null;
            if(!modelState.download) {
              toast('Model installed. You can now transcribe offline.');
              if(state.view === 'studio' && modelReady()) $('.setup-action')?.remove();
              if(state.view==='review') refreshTranscript();
            } else if(state.view!=='settings') toast(`Model download failed. ${modelState.download.message}`,true);
          }
        } catch(err) { clearInterval(modelPoll); modelPoll=null; notifyError(err); }
      },1600);
    }
  }

  return { applyModelState };
}

export { createModelManager };
