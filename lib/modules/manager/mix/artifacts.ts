import is from '@sindresorhus/is';
import { quote } from 'shlex';
import { TEMPORARY_ERROR } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { exec } from '../../../util/exec';
import type { ExecOptions } from '../../../util/exec/types';
import {
  deleteLocalFile,
  ensureCacheDir,
  findLocalSiblingOrParent,
  getSiblingFileName,
  localPathExists,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs';
import * as hostRules from '../../../util/host-rules';
import { regEx } from '../../../util/regex';

import type { UpdateArtifact, UpdateArtifactsResult } from '../types';

const hexRepoUrl = 'https://hex.pm/';
const hexRepoOrgUrlRegex = regEx(
  `^https://hex\\.pm/api/repos/(?<organization>[a-z0-9_]+)/$`,
);

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`mix.getArtifacts(${packageFileName})`);
  const { isLockFileMaintenance } = config;

  if (is.emptyArray(updatedDeps) && !isLockFileMaintenance) {
    logger.debug('No updated mix deps');
    return null;
  }

  let lockFileName = getSiblingFileName(packageFileName, 'mix.lock');
  let isUmbrella = false;

  let existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    const lockFileError = await checkLockFileReadError(lockFileName);
    if (lockFileError) {
      return lockFileError;
    }

    const parentLockFileName = await findLocalSiblingOrParent(
      packageFileName,
      'mix.lock',
    );
    existingLockFileContent =
      parentLockFileName && (await readLocalFile(parentLockFileName, 'utf8'));

    if (parentLockFileName && existingLockFileContent) {
      lockFileName = parentLockFileName;
      isUmbrella = true;
    } else if (parentLockFileName) {
      const lockFileError = await checkLockFileReadError(parentLockFileName);
      if (lockFileError) {
        return lockFileError;
      }
    }
  }

  if (isLockFileMaintenance && isUmbrella) {
    logger.debug(
      'Cannot use lockFileMaintenance in an umbrella project, see https://docs.renovatebot.com/modules/manager/mix/#lockFileMaintenance',
    );
    return null;
  }

  if (isLockFileMaintenance && !existingLockFileContent) {
    logger.debug(
      'Cannot use lockFileMaintenance when no mix.lock file is present',
    );
    return null;
  }

  try {
    await writeLocalFile(packageFileName, newPackageFileContent);
    if (isLockFileMaintenance) {
      await deleteLocalFile(lockFileName);
    }
  } catch (err) {
    logger.warn({ err }, 'mix.exs could not be written');
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }

  if (!existingLockFileContent) {
    logger.debug('No mix.lock found');
    return null;
  }

  const organizations = new Set<string>();

  const hexHostRulesWithMatchHost = hostRules
    .getAll()
    .filter(
      (hostRule) =>
        !!hostRule.matchHost && hexRepoOrgUrlRegex.test(hostRule.matchHost),
    );

  for (const { matchHost } of hexHostRulesWithMatchHost) {
    if (matchHost) {
      const result = hexRepoOrgUrlRegex.exec(matchHost);

      if (result?.groups) {
        const { organization } = result.groups;
        organizations.add(organization);
      }
    }
  }

  for (const { packageName } of updatedDeps) {
    if (packageName) {
      const [, organization] = packageName.split(':');

      if (organization) {
        organizations.add(organization);
      }
    }
  }

  const preCommands = Array.from(organizations).reduce((acc, organization) => {
    const url = `${hexRepoUrl}api/repos/${organization}/`;
    const { token } = hostRules.find({ url });

    if (token) {
      logger.debug(`Authenticating to hex organization ${organization}`);
      const authCommand = `mix hex.organization auth ${organization} --key ${token}`;
      return [...acc, authCommand];
    }

    return acc;
  }, [] as string[]);

  const execOptions: ExecOptions = {
    extraEnv: {
      // https://hexdocs.pm/mix/1.15.0/Mix.Tasks.Archive.html
      // TODO: should include a version constraint
      MIX_ARCHIVES: await ensureCacheDir('mix_archives'),
    },
    cwdFile: packageFileName,
    docker: {},
    toolConstraints: [
      {
        toolName: 'erlang',
        // https://hexdocs.pm/elixir/1.14.5/compatibility-and-deprecations.html#compatibility-between-elixir-and-erlang-otp
        constraint: config.constraints?.erlang ?? '^26',
      },
      {
        toolName: 'elixir',
        constraint: config.constraints?.elixir,
      },
    ],
    preCommands,
  };

  let command: string;
  if (isLockFileMaintenance) {
    command = 'mix deps.get';
  } else {
    command = [
      'mix',
      'deps.update',
      ...updatedDeps
        .map((dep) => dep.depName)
        .filter(is.string)
        .map((dep) => quote(dep)),
    ].join(' ');
  }

  try {
    await exec(command, execOptions);
  } catch (err) {
    /* v8 ignore next 3 */
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }

    logger.debug(
      { err, message: err.message, command },
      'Failed to update Mix lock file',
    );

    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }

  const newMixLockContent = await readLocalFile(lockFileName, 'utf8');
  if (existingLockFileContent === newMixLockContent) {
    logger.debug('mix.lock is unchanged');
    return null;
  }
  logger.debug('Returning updated mix.lock');
  return [
    {
      file: {
        type: 'addition',
        path: lockFileName,
        contents: newMixLockContent,
      },
    },
  ];
}

async function checkLockFileReadError(
  lockFileName: string,
): Promise<UpdateArtifactsResult[] | null> {
  if (await localPathExists(lockFileName)) {
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: `Error reading ${lockFileName}`,
        },
      },
    ];
  }
  return null;
}
