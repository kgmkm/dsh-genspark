/**
 * Browser half of dsh-genspark: the card that turns the Genspark `web_search` replacement on and off.
 *
 * Why this file exists: the Web GUI has no page that renders a Host plugin schema by itself. A
 * settings card is a *client* contribution — the official Web search page is the same shape
 * (`@deepseek-ai/dsh-client-ui-settings-web-search`), and third-party plugins such as
 * dsh-config-manager ship a `dsh.client` half the same way. Without one the `webSearch.*` fields
 * are still writable through the settings service, but nothing in the GUI shows them.
 *
 * The bundle format is the host's client module system (`dsh-client-modules`): the package declares
 * `dsh.client` in package.json, this file is its `./client` export, and `factory(require)` may use
 * only the shared modules (`react`, client packages).
 */

window.__ModuleLoader__.load({
  id: 'dsh-genspark',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require('react');

    /** Host plugin entry id, which is also the settings namespace this card writes. */
    const ENTRY_ID = 'dsh-genspark';

    /** Client services: slot registration, and the shared configuration forms. */
    const inject = ['slots', 'configForms'];

    const styles = {
      card: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      body: { margin: 0, fontSize: '13px', lineHeight: '20px', opacity: 0.75 },
      row: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', lineHeight: '20px' },
      checkbox: { marginTop: '3px', flex: 'none' },
      note: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.6 },
      indent: { paddingLeft: '24px' },
    };

    /**
     * Subscribe to a shared configuration form.
     *
     * `subscribe` and `getSnapshot` are methods on the controller, so they are rebound once: passing
     * them unbound to `useSyncExternalStore` would lose `this`.
     */
    function useFormState(form) {
      const subscribe = react.useCallback(
        (listener) => (typeof form?.subscribe === 'function' ? form.subscribe(listener) : () => {}),
        [form],
      );
      const getSnapshot = react.useCallback(
        () => (typeof form?.getSnapshot === 'function' ? form.getSnapshot() : { status: 'unavailable' }),
        [form],
      );
      return react.useSyncExternalStore(subscribe, getSnapshot);
    }

    /** One checkbox row: the value comes from the form, the write goes straight back to the Host. */
    function Field({ id, label, hint, checked, disabled, onChange }) {
      return react.createElement(
        'div',
        { style: styles.row },
        react.createElement('input', {
          id,
          type: 'checkbox',
          style: styles.checkbox,
          checked,
          disabled,
          onChange: (event) => onChange(event.currentTarget.checked),
        }),
        react.createElement(
          'label',
          { htmlFor: id },
          label,
          hint === undefined ? null : react.createElement('div', { style: { opacity: 0.7 } }, hint),
        ),
      );
    }

    /**
     * The Genspark card.
     *
     * Two switches, written immediately (no Save button): both fields are `.volatile()` on the Host,
     * so the running plugin picks the change up through `loader/volatile-update` and no restart is
     * involved. Everything the card shows comes from the shared form, never from local state.
     */
    function GensparkCard({ form }) {
      const state = useFormState(form);
      const loading = state.status === 'loading';
      const ready = state.status === 'ready' && state.writable !== false;
      const enabled = state.value?.webSearch?.enabled === true;
      const autoSelect = state.value?.webSearch?.autoSelect !== false;

      const write = (field, value) => {
        try {
          const result = form.mutate([{ op: 'set', path: ['webSearch', field], value }]);
          if (result !== undefined && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          /* the next snapshot still comes from the Host, so a refused write needs no local rollback */
        }
      };

      return react.createElement(
        'section',
        { style: styles.card },
        react.createElement('h3', { style: styles.title }, 'Genspark web search'),
        react.createElement(
          'p',
          { style: styles.body },
          'Answer the built-in web_search with Genspark instead of the DeepSeek search API. ' +
            'Useful when that API has no valid key: every call fails with HTTP 401 and no setting on the ' +
            'Web search page can fix it.',
        ),
        loading
          ? react.createElement('p', { style: styles.body }, 'Loading…')
          : react.createElement(
              react.Fragment,
              null,
              react.createElement(Field, {
                id: 'dsh-genspark-enabled',
                label: 'Use Genspark for web_search',
                hint: 'Registers the "genspark" provider and points web.searchProvider at it. Turning this off gives the previous selection back.',
                checked: enabled,
                disabled: !ready,
                onChange: (value) => write('enabled', value),
              }),
              react.createElement(
                'div',
                { style: styles.indent },
                react.createElement(Field, {
                  id: 'dsh-genspark-autoselect',
                  label: 'Select it automatically',
                  hint: 'Off: register the provider only and choose it yourself (web.searchProvider, or DSH_WEB_SEARCH_PROVIDER=genspark).',
                  checked: autoSelect,
                  disabled: !ready || !enabled,
                  onChange: (value) => write('autoSelect', value),
                }),
              ),
            ),
        state.status === 'unavailable' || state.writable === false
          ? react.createElement('p', { style: styles.note }, 'This profile does not accept settings edits from the browser.')
          : null,
        react.createElement(
          'p',
          { style: styles.note },
          'Each search spends Genspark credits and waits for the local gsk process to start. ' +
            'web_fetch is not affected.',
        ),
      );
    }

    /**
     * Mount the card while the Host serves this plugin's settings namespace.
     *
     * `whileServed` keeps the card off a deployment that never loaded the plugin, and the card is
     * appended to the Plugins panel's item list — the same list the official Web search card uses.
     *
     * The form itself is owned by `configForms`: it stays in the provider's cache, is disposed with
     * the provider, and disposing it here would leave a dead controller behind for the next mount.
     */
    function apply(ctx) {
      const form = ctx.configForms.get(ENTRY_ID);
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'dsh-genspark',
                  order: 60,
                  label: () => 'Genspark',
                  inject: () => ({ form }),
                },
                GensparkCard,
              ),
            ),
          ),
        'dsh-genspark: settings card',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
