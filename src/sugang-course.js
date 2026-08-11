export function normalizeSugangCourse(course) {
  const courseCode = String(course?.courseCode ?? "").trim().toUpperCase();
  const section = String(course?.section ?? "").trim().toUpperCase();
  if (!courseCode || courseCode.includes("@")) {
    throw new Error("courseCode is required and must not contain @");
  }
  if (!section || section.includes("@")) {
    throw new Error("section is required and must not contain @");
  }
  return Object.freeze({ courseCode, section, params: `${courseCode}@${section}` });
}

export function parseSugangCourse(value) {
  if (typeof value !== "string") throw new Error("Course must use COURSE_CODE@SECTION");
  const parts = value.trim().split("@");
  if (parts.length !== 2) {
    throw new Error(`Invalid course ${JSON.stringify(value)}; use COURSE_CODE@SECTION`);
  }
  return normalizeSugangCourse({ courseCode: parts[0], section: parts[1] });
}
