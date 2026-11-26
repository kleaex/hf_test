// 高度なDriveサービス(v3)が利用できる場合、読取時の確認情報を1要求で取得する。
function driveMetadataApiAvailable_() {
  return typeof Drive !== 'undefined' && Drive.Files && typeof Drive.Files.get === 'function';
}

function privateReadMetadata_(id) {
  return timed_('driveMetadataApi', function () {
    const metadata = Drive.Files.get(id, { supportsAllDrives: false,
      fields: 'id,mimeType,trashed,driveId,ownedByMe,shared,parents,modifiedTime,owners(me,permissionId),permissions(id,type,role,deleted)' });
    // 必須情報の欠落や所有者以外の権限がある場合も、非公開とは判断しない。
    const owner = metadata && Array.isArray(metadata.owners) && metadata.owners.length === 1 ? metadata.owners[0] : null;
    const permissions = metadata && metadata.permissions;
    if (!metadata || metadata.id !== id || metadata.trashed !== false || metadata.shared !== false
        || metadata.ownedByMe !== true || metadata.driveId || !owner || owner.me !== true
        || typeof owner.permissionId !== 'string' || !owner.permissionId
        || !Array.isArray(permissions) || permissions.length !== 1 || !permissions[0]
        || permissions[0].id !== owner.permissionId || permissions[0].type !== 'user'
        || permissions[0].role !== 'owner' || permissions[0].deleted
        || typeof metadata.modifiedTime !== 'string' || !Number.isFinite(Date.parse(metadata.modifiedTime))
        || ['application/vnd.google-apps.folder', 'image/png', 'image/jpeg'].indexOf(metadata.mimeType) < 0) {
      fail_('IMAGE_CONFIG', '画像保存先または画像の非公開状態を確認できません。運営に確認してください。');
    }
    return metadata;
  });
}
