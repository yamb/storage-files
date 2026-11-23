import { YambError } from '#core/errors';

export class FilesConfigError extends YambError {
  static code = 'YAMB_FILES_CONFIG';
}

export class FilesOpenError extends YambError {
  static code = 'YAMB_FILES_OPEN';
}
