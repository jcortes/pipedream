const { readFile } = require("fs/promises");
const core = require("@actions/core");
const { exec } = require("@actions/exec");
const difference = require("lodash.difference");
const dependencyTree = require("dependency-tree");

const allowedExtensions = ["js", "mjs", "ts"];
const componentFiles = new RegExp("^.*components\/.*\/sources|actions\/.*\.[t|j|mj]s$");
const commonFiles = new RegExp("^.*common.*\.[t|j|mj]s$");
const otherFiles = new RegExp("^.*components\/.*\.[t|j|mj]s$");

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
        const args = ["diff", "--unified=0", `${baseCommit}...${headCommit}`, filePath];
        return {
          filePath,
          contents: await execCmd("git", args)
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

function getPendingFilePaths(filePaths = []) {
  return filePaths.reduce((reduction, filePath) => {
    const tree =
      dependencyTree
        .toList({
          directory: __dirname,
          filename: filePath,
          filter: path => path.indexOf("node_modules") === -1
        })
        .filter(path => path.indexOf(filePath) === -1);
    return reduction.concat(difference(tree, reduction));
  }, []);
}

async function run() {
  try {
    const filteredFilePaths = getFilteredFilePaths({ allFilePaths: allFiles });
    const componentsThatDidNotModifyVersion = await processFiles({ filePaths: filteredFilePaths });

    const filteredWithOtherFilePaths = getFilteredFilePaths({ allFilePaths: allFiles, allowOtherFiles: true });
    const otherFiles = difference(filteredWithOtherFilePaths, filteredFilePaths);
    const pendingFilesToCheck = getPendingFilePaths(otherFiles);
    const uncommitedComponentsThatDidNotModifyVersion = await processFiles({ filePaths: pendingFilesToCheck, uncommited: true });
    
    const pendingComponentFilePaths = componentsThatDidNotModifyVersion.concat(uncommitedComponentsThatDidNotModifyVersion);

    pendingComponentFilePaths.forEach((filePath) => {
      console.log(`You didn't modify the version of ${filePath}`);
    });

    if (pendingComponentFilePaths.length) {
      core.setFailed("You need to increment the version on some components. Please see the output above and https://pipedream.com/docs/components/guidelines/#versioning for more information");
    }

    core.setOutput("pending_component_file_paths", pendingComponentFilePaths);
  
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();