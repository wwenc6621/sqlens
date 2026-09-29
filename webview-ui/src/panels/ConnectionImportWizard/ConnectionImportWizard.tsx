import React, { useState, useEffect, useCallback, useRef } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import { t } from '../../i18n';
import './ConnectionImportWizard.css';

interface PreviewItem {
  index: number;
  name: string;
  type: string;
  host?: string;
  port?: number;
  username?: string;
  hasPassword: boolean;
  database?: string;
  filepath?: string;
  group?: string;
  issues: string[];
}

interface ParseResultData {
  format: string;
  error?: string;
  items: PreviewItem[];
}

interface EditState {
  name: string;
  group: string;
}

const SUPPORTED = 'sqlens JSON · URI · CSV / TSV · .env · Spring yml/properties · DBeaver · DataGrip · Navicat · TablePlus';

export default function ConnectionImportWizard() {
  const [step, setStep] = useState<'source' | 'preview' | 'done'>('source');
  const [text, setText] = useState('');
  const [defaultGroup, setDefaultGroup] = useState('');
  const [result, setResult] = useState<ParseResultData | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, EditState>>({});
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [imported, setImported] = useState(0);
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return onMessage((message: { type: string; data?: any }) => {
      switch (message.type) {
        case 'importWizardParseResult': {
          const data = message.data as ParseResultData;
          setResult(data);
          setParsing(false);
          if (!data.error && data.items.length > 0) {
            setSelected(new Set(data.items.map(i => i.index)));
            setEdits({});
            setStep('preview');
          } else if (data.error) {
            // stay on source step; the error shows under the textarea
          }
          break;
        }
        case 'importWizardText':
          setText(message.data.text);
          break;
        case 'importWizardDone':
          setImported(message.data.imported);
          setStep('done');
          break;
        case 'importWizardGroups':
          setExistingGroups(message.data.groups || []);
          break;
      }
    });
  }, []);

  useEffect(() => {
    postMessage({ type: 'importWizardGetGroups' });
  }, []);

  const requestParse = useCallback((sourceText: string) => {
    if (!sourceText.trim()) { return; }
    setParsing(true);
    postMessage({ type: 'importWizardParse', data: { text: sourceText } });
  }, []);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) { return; }
    // Import the first file; concatenating heterogeneous formats would confuse the sniffer.
    const content = await files[0].text();
    setText(content);
    requestParse(content);
  }, [requestParse]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const commit = useCallback(() => {
    const picks = [...selected].map(index => ({
      index,
      name: edits[index]?.name,
      group: edits[index]?.group ?? defaultGroup,
    }));
    postMessage({ type: 'importWizardCommit', data: { text, picks } });
  }, [selected, edits, defaultGroup, text]);

  const toggle = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) { next.delete(index); } else { next.add(index); }
      return next;
    });
  };

  const setEdit = (index: number, field: keyof EditState, value: string) => {
    setEdits(prev => ({
      ...prev,
      [index]: { name: prev[index]?.name || '', group: prev[index]?.group ?? '', [field]: value },
    }));
  };

  const warningCount = result?.items.reduce((n, i) => n + i.issues.length, 0) ?? 0;

  if (step === 'done') {
    return (
      <div className="ciw">
        <div className="ciw-done">
          <div className="ciw-done-icon">✓</div>
          <h2>{t('Import complete')}</h2>
          <p>{imported} {imported === 1 ? t('connection imported') : t('connections imported')}</p>
          <button className="ciw-btn-primary" onClick={() => { setStep('source'); setText(''); setResult(null); }}>
            {t('Import more')}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'preview' && result) {
    return (
      <div className="ciw">
        <h2 className="ciw-title">{t('Preview connections')}</h2>
        <datalist id="ciw-existing-groups">
          {existingGroups.map(g => <option key={g} value={g} />)}
        </datalist>
        <div className="ciw-meta">
          {t('Source')}: {result.format} · {result.items.length} {t('found')}
          {warningCount > 0 && <span className="ciw-warn-badge">⚠ {warningCount}</span>}
        </div>
        <div className="ciw-list">
          {result.items.map(item => (
            <div key={item.index} className={'ciw-row' + (selected.has(item.index) ? ' selected' : '')}>
              <input
                type="checkbox"
                checked={selected.has(item.index)}
                onChange={() => toggle(item.index)}
              />
              <div className="ciw-row-main">
                <div className="ciw-row-head">
                  <span className={'ciw-type type-' + item.type}>{item.type}</span>
                  <span className="ciw-name">{item.name}</span>
                  <span className="ciw-host">
                    {item.filepath || [item.host, item.port].filter(Boolean).join(':')}
                  </span>
                  {item.username && <span className="ciw-user">{item.username}</span>}
                  {item.issues.length > 0 && (
                    <span className="ciw-issue" title={item.issues.join('\n')}>⚠</span>
                  )}
                </div>
                {selected.has(item.index) && (
                  <div className="ciw-row-edit">
                    <label>
                      {t('Name')}
                      <input
                        type="text"
                        value={edits[item.index]?.name ?? item.name}
                        onChange={e => setEdit(item.index, 'name', e.target.value)}
                      />
                    </label>
                    <label>
                      {t('Group')}
                      <input
                        type="text"
                        list="ciw-existing-groups"
                        value={edits[item.index]?.group ?? item.group ?? defaultGroup}
                        placeholder={defaultGroup}
                        onChange={e => setEdit(item.index, 'group', e.target.value)}
                      />
                    </label>
                    {item.issues.length > 0 && (
                      <div className="ciw-row-issues">{item.issues.join(' · ')}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="ciw-footer">
          <span className="ciw-summary">
            {selected.size} / {result.items.length} {t('selected')}
            {warningCount > 0 && ` · ${t('Passwords will be imported empty when unavailable')}`}
          </span>
          <div className="ciw-footer-actions">
            <button className="ciw-btn" onClick={() => setStep('source')}>{t('Back')}</button>
            <button
              className="ciw-btn-primary"
              disabled={selected.size === 0}
              onClick={commit}
            >
              {t('Import')} ({selected.size})
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ciw">
      <h2 className="ciw-title">{t('Import Connections')}</h2>
      <datalist id="ciw-existing-groups">
        {existingGroups.map(g => <option key={g} value={g} />)}
      </datalist>

      <div
        className={'ciw-dropzone' + (dragOver ? ' dragover' : '')}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
      >
        <div className="ciw-dropzone-icon">📂</div>
        <div className="ciw-dropzone-title">{t('Choose a file or drag it here')}</div>
        <div className="ciw-dropzone-hint">{t('Supported formats')}: {SUPPORTED}</div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,.tsv,.txt,.env,.ncx,.yml,.yaml,.properties"
          style={{ display: 'none' }}
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      <div className="ciw-section-title">{t('Or paste content (URIs, JSON, table rows, .env…)')}</div>
      <textarea
        className="ciw-textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={'mysql://user@host:3306/db\nDATABASE_URL=postgres://…'}
        rows={6}
      />
      {result?.error && <div className="ciw-error">{result.error}</div>}

      <div className="ciw-options">
        <label>
          {t('Import into group')}
          <input
            type="text"
            list="ciw-existing-groups"
            value={defaultGroup}
            onChange={e => setDefaultGroup(e.target.value)}
            placeholder={t('leave empty for default group')}
          />
        </label>
        <button className="ciw-btn" onClick={() => postMessage({ type: 'importWizardReadClipboard' })}>
          {t('Read clipboard')}
        </button>
      </div>

      <button
        className="ciw-btn-primary ciw-next"
        disabled={!text.trim() || parsing}
        onClick={() => requestParse(text)}
      >
        {parsing ? t('Parsing…') : `${t('Next: Preview')}${text.trim() ? '' : ''}`}
      </button>
    </div>
  );
}
