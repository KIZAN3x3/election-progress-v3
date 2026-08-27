/**
 * スタンドアロンのGoogle Apps Scriptプロジェクト用スクリプト。
 * GitHub Actionsのscheduled cron（15分間隔）がGitHub側の間引きにより
 * 実際には数時間おきにしか実行されない問題への対処として、
 * 時間主導型トリガー（15分ごと）からこの関数を呼び出し、
 * workflow_dispatch APIで確実にワークフローを起動する。
 *
 * 事前準備（script.google.com側の設定）:
 * 1. プロジェクトの「プロジェクトの設定」→「スクリプト プロパティ」で
 *    キー GITHUB_PAT に、対象リポジトリへの Actions: Read and write
 *    権限のみを持つ GitHub Personal Access Token を登録する
 * 2. 時間主導型トリガーで triggerSyncWorkflow を15分ごとに実行するよう設定する
 */
function triggerSyncWorkflow() {
  const REPO_OWNER = 'kizan3x3';
  const REPO_NAME = 'election-progress-v3';
  const WORKFLOW_FILE = 'sync-sheets.yml';
  const REF = 'main';

  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_PAT');
  if (!token) {
    Logger.log('失敗: Script Propertiesに GITHUB_PAT が設定されていません');
    return;
  }

  const url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
    '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';

  const options = {
    method: 'post',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json'
    },
    contentType: 'application/json',
    payload: JSON.stringify({ ref: REF }),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();

    if (statusCode === 204) {
      Logger.log('成功: workflow_dispatchをトリガーしました（status ' + statusCode + '）');
    } else {
      Logger.log('失敗: status ' + statusCode + ', body: ' + response.getContentText());
    }
  } catch (e) {
    Logger.log('例外発生: ' + e.message);
  }
}
