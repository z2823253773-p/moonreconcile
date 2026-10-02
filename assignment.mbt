///|
priv struct PairIndex {
  left : Int
  right : Int
  weight : Int
}

///|
priv struct WeightedEdge {
  left : Int
  right : Int
  weight : Int
}

///|
/// Maximum-weight partial one-to-one assignment. Rows/columns are zero-based.
fn solve_assignment(
  left_count : Int,
  right_count : Int,
  edges : Array[WeightedEdge],
) -> Array[PairIndex] {
  if left_count <= 0 ||
    right_count <= 0 ||
    left_count > 100 ||
    right_count > 100 {
    return []
  }
  let n = left_count + right_count
  let forbidden = 100000000
  let cost = Array::makei(n, fn(_) { Array::make(n, 0) })
  for i in 0..<left_count {
    for j in 0..<right_count {
      cost[i][j] = forbidden
    }
  }
  for edge in edges {
    if edge.left >= 0 &&
      edge.left < left_count &&
      edge.right >= 0 &&
      edge.right < right_count &&
      edge.weight > 0 {
      let current = cost[edge.left][edge.right]
      if current == forbidden || edge.weight > -current {
        cost[edge.left][edge.right] = -edge.weight
      }
    }
  }
  let u = Array::make(n + 1, 0)
  let v = Array::make(n + 1, 0)
  let p = Array::make(n + 1, 0)
  let way = Array::make(n + 1, 0)
  for outer in 0..<n {
    let i = outer + 1
    p[0] = i
    let j0 = Ref(0)
    let minv = Array::make(n + 1, forbidden * 2)
    let used = Array::make(n + 1, false)
    let done = Ref(false)
    while !done.val {
      used[j0.val] = true
      let i0 = p[j0.val]
      let delta = Ref(forbidden * 2)
      let j1 = Ref(0)
      for j0index in 0..<n {
        let j = j0index + 1
        if !used[j] {
          let cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
          if cur < minv[j] {
            minv[j] = cur
            way[j] = j0.val
          }
          if minv[j] < delta.val {
            delta.val = minv[j]
            j1.val = j
          }
        }
      }
      for j in 0..<=n {
        if used[j] {
          u[p[j]] += delta.val
          v[j] -= delta.val
        } else if j > 0 {
          minv[j] -= delta.val
        }
      }
      j0.val = j1.val
      if p[j0.val] == 0 {
        done.val = true
      }
    }
    let augmenting = Ref(true)
    while augmenting.val {
      let j1 = way[j0.val]
      p[j0.val] = p[j1]
      j0.val = j1
      if j0.val == 0 {
        augmenting.val = false
      }
    }
  }
  let result : Array[PairIndex] = []
  for j0index in 0..<n {
    let j = j0index + 1
    let row = p[j] - 1
    let col = j - 1
    if row >= 0 &&
      row < left_count &&
      col >= 0 &&
      col < right_count &&
      cost[row][col] != forbidden {
      result.push({ left: row, right: col, weight: -cost[row][col], })
    }
  }
  result
}
