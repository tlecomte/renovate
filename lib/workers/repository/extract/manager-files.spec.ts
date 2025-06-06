import type { RenovateConfig } from '../../../config/types';
import * as _html from '../../../modules/manager/html';
import * as _fileMatch from './file-match';
import { getManagerPackageFiles } from './manager-files';
import { fs, partial } from '~test/util';

vi.mock('./file-match');
vi.mock('../../../modules/manager/html');
vi.mock('../../../util/fs');

const fileMatch = vi.mocked(_fileMatch);
const html = vi.mocked(_html);

describe('workers/repository/extract/manager-files', () => {
  describe('getManagerPackageFiles()', () => {
    let config: RenovateConfig;

    beforeEach(() => {
      config = partial<RenovateConfig>();
    });

    it('returns empty of manager is disabled', async () => {
      const managerConfig = { manager: 'travis', enabled: false, fileList: [] };
      const res = await getManagerPackageFiles(managerConfig);
      expect(res).toHaveLength(0);
    });

    it('returns empty of manager is not enabled', async () => {
      config.enabledManagers = ['npm'];
      const managerConfig = { manager: 'docker', enabled: true, fileList: [] };
      const res = await getManagerPackageFiles(managerConfig);
      expect(res).toHaveLength(0);
    });

    it('skips files if null content returned', async () => {
      const managerConfig = {
        manager: 'npm',
        fileList: [],
        enabled: true,
      };
      fileMatch.getMatchingFiles.mockReturnValue(['package.json']);
      const res = await getManagerPackageFiles(managerConfig);
      expect(res).toHaveLength(0);
    });

    it('returns files with extractPackageFile', async () => {
      const managerConfig = {
        manager: 'html',
        enabled: true,
        fileList: ['Dockerfile'],
      };
      fileMatch.getMatchingFiles.mockReturnValue(['Dockerfile']);
      fs.readLocalFile.mockResolvedValueOnce('some content');
      html.extractPackageFile = vi.fn(() => ({
        deps: [{}, { replaceString: 'abc', packageName: 'p' }],
      })) as never;
      const res = await getManagerPackageFiles(managerConfig);
      expect(res).toEqual([
        {
          packageFile: 'Dockerfile',
          deps: [{}, { replaceString: 'abc', packageName: 'p', depName: 'p' }],
        },
      ]);
    });

    it('returns files with extractAllPackageFiles', async () => {
      const managerConfig = {
        manager: 'npm',
        enabled: true,
        fileList: ['package.json'],
      };
      fileMatch.getMatchingFiles.mockReturnValue(['package.json']);
      fs.readLocalFile.mockResolvedValueOnce(
        '{"dependencies":{"chalk":"2.0.0"}}',
      );
      const res = await getManagerPackageFiles(managerConfig);
      expect(res).toMatchObject([
        {
          packageFile: 'package.json',
          deps: [
            {
              currentValue: '2.0.0',
              datasource: 'npm',
              depName: 'chalk',
              depType: 'dependencies',
            },
          ],
        },
      ]);
    });
  });
});
