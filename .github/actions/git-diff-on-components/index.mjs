import { readFile } from "fs/promises";
import core from "@actions/core";
import { exec } from "@actions/exec";

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
  console.log("allowOtherFiles", allowOtherFiles);
  return allFilePaths
    .filter((filePath) => {
      const otherFilesCheck =
        allowOtherFiles
          ? commonFiles.test(filePath) || otherFiles.test(filePath)
          : !commonFiles.test(filePath);
          const [extension] = filePath.split(".").reverse();
      const validation = !filePath.startsWith(".")
        && allowedExtensions.includes(extension)
        && componentFiles.test(filePath)
        && otherFilesCheck;
      console.log(
        "filePath",
        filePath,
        !filePath.startsWith("."),
        allowedExtensions.includes(extension),
        componentFiles.test(filePath),
        otherFilesCheck
      );
      return validation;
    });
}

async function getFilesContent(filteredFilePaths = []) {
  const contentFilesPromises =
    filteredFilePaths
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
          diffContent: await execCmd("git", args)
        };
      });

  return Promise.all(diffContentPromises);
}

function getUnmodifiedComponents(diffsContent) {
  return diffsContent
    .filter(({ diffContent }) => !diffContent.includes("version:"))
    .map(({ filePath }) => filePath);
}

async function run() {
  try {
    const filteredWithCommonFilePaths = getFilteredFilePaths({ allFilePaths: allFiles, allowOtherFiles: true });
    const filteredFilePaths = getFilteredFilePaths({ allFilePaths: allFiles });
    const filesContent = await getFilesContent(filteredFilePaths);
    const diffsContent = await getDiffsContent(filesContent);
    const componentsThatDidNotModifyVersion = getUnmodifiedComponents(diffsContent);

    console.log("filteredFilePaths", filteredFilePaths);
    console.log("filteredWithCommonFilePaths", filteredWithCommonFilePaths);

    componentsThatDidNotModifyVersion.forEach((filePath) => {
      console.log(`You didn't modify the version of ${filePath}`);
    });

    if (componentsThatDidNotModifyVersion.length) {
      core.setFailed("You need to increment the version on some components. Please see the output above and https://pipedream.com/docs/components/guidelines/#versioning for more information");
    }

    core.setOutput("components_that_did_not_modify_version", componentsThatDidNotModifyVersion);
  
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();