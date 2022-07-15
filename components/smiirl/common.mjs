import smiirl from "./smiirl.app.mjs";
import utils from "./common/utils.mjs";

console.log(utils.summaryEnd(1, "entity", "entities"));

export default {
  props: {
    smiirl,
    commonProperty: {
      propDefinition: [
        smiirl,
        "commonProperty",
      ],
    },
  },
};
