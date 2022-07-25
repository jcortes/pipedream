const { join } = require("path");
const { readFile, readdir, lstat } = require("fs/promises");
const core = require("@actions/core");
const { exec } = require("@actions/exec");
const dependencyTree = require("dependency-tree");
const difference = require("lodash.difference");
const uniqWith = require('lodash.uniqwith');

const allowedExtensions = ["js", "mjs", "ts"];
const componentFiles = new RegExp("^.*components\/.*\/sources|actions\/.*\.[t|j|mj]s$");
const commonFiles = new RegExp("^.*common.*\.[t|j|mj]s$");
const otherFiles = new RegExp("^.*components\/.*\.[t|j|mj]s$");
const extensionsRegExp = new RegExp("\.[t|j|mj]s$");

const baseCommit = core.getInput("base_commit");
const headCommit = core.getInput("head_commit");
const allFiles = JSON.parse(core.getInput("all_files"));

async function execCmd(...args) {
  let output = "";
  let error = "";

  return new Promise(async (resolve, reject) => {
    await exec(...args, {
      listeners: {
        stdout: (data) => {
          output += data.toString();
        },
        stderr: (data) => {
          error += data.toString();
        }
      }
    });
    if (error) {
      return reject(error);
    }
    return resolve(output)
  });
}

async function execGitDiffContents(filePath) {
  const args = ["diff", "--unified=0", `${baseCommit}...${headCommit}`, filePath];
  return execCmd("git", args);
}

function getFilteredFilePaths({ allFilePaths = [], allowOtherFiles } = {}) {
  return allFilePaths
    .filter((filePath) => {
      const otherFilesCheck =
        allowOtherFiles
          ? commonFiles.test(filePath) || otherFiles.test(filePath)
          : componentFiles.test(filePath) && !commonFiles.test(filePath);
          const [extension] = filePath.split(".").reverse();
      return !filePath.startsWith(".")
        && allowedExtensions.includes(extension)
        && otherFilesCheck;
    });
}

function fileExist(filePath) {
  return new Promise(async (resolve) => {
    try {
      await lstat(filePath);
      return resolve(true);
    } catch (error) {
      return resolve(false);
    }
  });
}

async function getExistingFilePaths(filePaths = []) {
  const existingFilePaths =
    filePaths
      .map(async (filePath) => ({
        filePath,
        exists: await fileExist(filePath)
      }));
  return Promise.all(existingFilePaths)
    .filter(({ exists }) => exists)
    .map(({ filePath }) => filePath);
}

async function getFilesContent(filePaths = []) {
  const contentFilesPromises =
    filePaths
      .map(async (filePath) => ({
        filePath,
        contents: await readFile(filePath, "utf-8")
      }));

  return Promise.all(contentFilesPromises);
}

async function getDiffsContent(filesContent = []) {
  const diffContentPromises =
    filesContent
      .filter(({ contents }) => contents.includes("version:"))
      .map(async ({ filePath }) => {
        return {
          filePath,
          contents: await execGitDiffContents(filePath)
        };
      });

  return Promise.all(diffContentPromises);
}

function getUnmodifiedComponents({ contents = [], uncommited } = {}) {
  return contents
    .filter(({ contents }) =>
      uncommited
        ? contents.includes("version:")
        : !contents.includes("version:"))
    .map(({ filePath }) => filePath);
}

async function processFiles({ filePaths = [], uncommited } = {}) {
  if (uncommited) {
    const filesContent = await getFilesContent(filePaths);
    return getUnmodifiedComponents({ contents: filesContent, uncommited });
  }

  const filesContent = await getFilesContent(filePaths);
  const diffsContent = await getDiffsContent(filesContent);
  return getUnmodifiedComponents({ contents: diffsContent });
}

async function deepReadDir (dirPath) {
  return Promise.all(
    (await readdir(dirPath))
      .map(async (entity) => {
        const path = join(dirPath, entity);
        return (await lstat(path)).isDirectory()
          ? await deepReadDir(path)
          : { dirPath, path };
      })
  );
}

async function getAllFilePaths({ componentsPath, apps = [] } = {}) {
  return Promise.all(apps.map((app) => deepReadDir(join(componentsPath ,app))))
    .then(reduceResult);
}

function getComponentName(dirPath) {
  const [, componentPath] = dirPath.split("components/");
  const [componentName] = componentPath.split("/");
  return componentName;
}

function isEqualComponent(filePath, otherFilePath) {
  return getComponentName(filePath) === getComponentName(otherFilePath);
}

function reduceResult(result) {
  return result
    .flat(Number.POSITIVE_INFINITY)
    .reduce((reduction, { dirPath, path }) => {
      if (dirPath.includes("node_modules") || !extensionsRegExp.test(path)) {
        return reduction;
      }

      const key = getComponentName(dirPath);
      const currentPaths = reduction[key] ?? [];

      return {
        ...reduction,
        [key]: [
          ...currentPaths,
          path
        ]
      };
    }, {});
}

function getDependencyFilesDict(allFilePaths) {
  return Object.entries(allFilePaths)
    .filter(([, paths]) => paths.length > 1)
    .reduce((reduction, [key, paths]) => {
      return {
        ...reduction,
        [key]: paths
      };
    }, {});
}

function getComponentsDependencies({ filePaths, dependencyFilesDict }) {
  const componentNames = uniqWith(filePaths, isEqualComponent).map(getComponentName);
  return componentNames.map((componentName) => {
    const selectedFilePaths = dependencyFilesDict[componentName];
    return selectedFilePaths.map((selectedFilePath) => {
      const [directory, newFilePath] = selectedFilePath.split("components/");
      const filename = `components/${newFilePath}`;
      const dependencies = dependencyTree
        .toList({
          directory,
          filename,
          filter: path => path.indexOf("node_modules") === -1
        })
        .filter(path => path.indexOf(filename) === -1);
      return {
        filePath: selectedFilePath,
        dependencies,
      };
    });
  }).flat(Number.POSITIVE_INFINITY);
}

function getFilesToBeCheckByDependency(componentsDependencies) {
  return componentsDependencies.reduce((mainReduction, { filePath, dependencies }) => {
    const nextReduction = dependencies.reduce((reductionDep, filePathDep) => {
      const currentDepPaths = reductionDep[filePathDep] || [];
      return {
        ...reductionDep,
        [filePathDep]: [
          ...currentDepPaths,
          filePath
        ]
      };
    }, {});

    const finalReduction = Object.entries(mainReduction)
      .reduce((reductionMerge, [mainFilePath, mainDependencies]) => {
        const nextReductionDependencies = nextReduction[mainFilePath];
        if (nextReductionDependencies) {
          return {
            ...reductionMerge,
            [mainFilePath]: [
              ...mainDependencies,
              ...nextReductionDependencies
            ]
          };
        }
        return {
          ...reductionMerge,
          [mainFilePath]: mainDependencies
        };
      }, {});

    return {
      ...mainReduction,
      ...nextReduction,
      ...finalReduction
    };
  }, {});
}

function getComponentsThatNeedToBeModified({ filesToBeCheckedByDependency, otherFiles }) {
  return Object.entries(filesToBeCheckedByDependency)
    .reduce(async (reduction, [filePath, filesToBeChecked]) => {
      const found = otherFiles.find((path) => filePath.includes(path));
      if (found) {
        const newFilePaths = await processFiles({ filePaths: filesToBeChecked, uncommited: true });
        return newFilePaths.length
          ? Promise.resolve({
            ...await reduction,
            [filePath]: newFilePaths
          })
          : await reduction;
      }
      return await reduction;
    }, Promise.resolve({}));
}

async function checkVersionModification(componentsPendingForGitDiff) {
  return componentsPendingForGitDiff
    .map(async ({ filePath, componentFilePath }) => ({
      filePath,
      contents: await execGitDiffContents(componentFilePath)
    }));
}

async function run() {
  const filteredFilePaths = getFilteredFilePaths({ allFilePaths: allFiles });
  const existingFilePaths = await getExistingFilePaths(filteredFilePaths);
  console.log("existingFilePaths", JSON.stringify(existingFilePaths));

  const componentsThatDidNotModifyVersion = await processFiles({ filePaths: existingFilePaths });

  componentsThatDidNotModifyVersion.forEach((filePath) => {
    console.log(`You didn't modify the version of ${filePath}`);
  });

  if (componentsThatDidNotModifyVersion.length) {
    core.setFailed("You need to increment the version on some components. Please see the output above and https://pipedream.com/docs/components/guidelines/#versioning for more information");
  }

  const filteredWithOtherFilePaths = getFilteredFilePaths({ allFilePaths: allFiles, allowOtherFiles: true });
  const otherFiles = difference(filteredWithOtherFilePaths, existingFilePaths);

  if (otherFiles.length) {
    console.log("Need to check each component in the repo and compare with otherFiles array");
    console.log("otherFiles", otherFiles);

    const componentsPath = join(__dirname, "/../../../../components");
    const apps = await readdir(componentsPath);
    const allFilePaths = await getAllFilePaths({ componentsPath, apps });
    const dependencyFilesDict = getDependencyFilesDict(allFilePaths);
    const componentsDependencies = getComponentsDependencies({ filePaths: otherFiles, dependencyFilesDict });
    const filesToBeCheckedByDependency = getFilesToBeCheckByDependency(componentsDependencies);
    const componentsThatNeedToBeModified = await getComponentsThatNeedToBeModified({ filesToBeCheckedByDependency, otherFiles });

    // console.log("componentsThatNeedToBeModified", JSON.stringify(componentsThatNeedToBeModified));

    const componentsPendingForGitDiff = 
      Object.entries(componentsThatNeedToBeModified)
        .map(async ([filePath, componentFilePaths]) =>
          componentFilePaths.map((componentFilePath) =>
            ({ filePath, componentFilePath })))
        .flat(Number.POSITIVE_INFINITY);
    console.log("componentsPendingForGitDiff", componentsPendingForGitDiff);

    const componentsDiffContents = await checkVersionModification(componentsPendingForGitDiff);
    console.log("componentsDiffContents", componentsDiffContents);

    
  }

  core.setOutput("pending_component_file_paths", componentsThatDidNotModifyVersion);
}

run()
  .catch(error => core.setFailed(error ?? error?.message));