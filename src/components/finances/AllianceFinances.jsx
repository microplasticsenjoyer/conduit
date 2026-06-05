import React from "react";
import Tabs from "../shared/Tabs.jsx";
import Fund from "./Fund.jsx";
import IncomeStatement from "./IncomeStatement.jsx";
import CorpProjects from "./CorpProjects.jsx";
import styles from "./AllianceFinances.module.css";

const SUB_OPTIONS = [
  { value: "income",    label: "Income Statement" },
  { value: "projects",  label: "Projects" },
  { value: "trustfund", label: "#trustfund" },
];

export default function AllianceFinances({ auth, isAdmin, sub, onSubChange }) {
  return (
    <div className={styles.wrap}>
      <Tabs
        value={sub}
        onChange={onSubChange}
        options={SUB_OPTIONS}
        variant="sub"
      />
      {sub === "trustfund" && <Fund auth={auth} />}
      {sub === "income"    && <IncomeStatement auth={auth} />}
      {sub === "projects"  && <CorpProjects auth={auth} isAdmin={isAdmin} />}
    </div>
  );
}
