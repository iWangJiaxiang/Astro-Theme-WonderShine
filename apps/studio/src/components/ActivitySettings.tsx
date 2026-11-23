import type { ContentLanguages } from '../../shared/types';
import { api, errorMessage } from '../api';
import { t, type Message } from '../i18n';
import { component } from '../react-component';
import { onBeforeUnmount, onMounted, ref } from '../reactivity';
import { ErrorNotice } from './ErrorNotice';
import LoadingState from './LoadingState';
import SettingsView from './SettingsView';

type Events = { dirty: [value: boolean]; saved: [] };

export default component<Record<never, never>, Events>('ActivitySettings', (_props, emit) => {
  const languages = ref<ContentLanguages>();
  const language = ref('');
  const dirty = ref(false);
  const error = ref<Message>('');
  let alive = true;

  onMounted(() => {
    void api<ContentLanguages>('/content-languages').then(result => {
      if (!alive) return;
      language.value = result.defaultLanguage;
      languages.value = result;
    }).catch(cause => { if (alive) error.value = errorMessage(cause); });
  });
  onBeforeUnmount(() => { alive = false; });

  return () => {
    if (error.value) return <ErrorNotice message={error.value} source="ActivitySettings" />;
    if (!languages.value) return <LoadingState label="正在加载站点…" compact />;

    return <>
      {languages.value.languages.length > 1 && <label className="settings-group-tabs small">
        {t('语言版本')}
        <select name="activity-language" value={language.value} disabled={dirty.value} onChange={event => { language.value = event.currentTarget.value; }}>
          {languages.value.languages.map(code => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>}
      <SettingsView key={language.value} group="activity" language={language.value} onDirty={value => {
        dirty.value = value;
        emit('dirty', value);
      }} onSaved={() => emit('saved')} />
    </>;
  };
});
