#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import numpy as np
import matplotlib.pyplot as plt
import time
from newton_solve import newton_solve

# -----------------------------
# Fixed problem setup
# -----------------------------
A = np.array([0.0, 0.0])      # left support r0
B = np.array([1.0, 0.0])      # right support rN
L = np.linalg.norm(B - A)     # horizontal span
W = 1.0                       # weight per interior node

# Values of N to test
N_values = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250]

# Store results
runtime_results = []
iteration_results = []
residual_results = []

# -----------------------------
# Loop over different N
# -----------------------------
for N in N_values:

    total_length = 1.20 * L
    s = total_length / N

    # -----------------------------
    # Utilities
    # -----------------------------
    def unpack_vars(v):
        npos = 2 * (N - 1)
        coords = v[:npos]
        T = v[npos:]

        r = [A]
        for k in range(N - 1):
            xk = coords[2 * k]
            yk = coords[2 * k + 1]
            r.append(np.array([xk, yk], dtype=float))
        r.append(B)

        return tuple(r), np.array(T, dtype=float)

    def unit(vec):
        n = np.linalg.norm(vec)
        if n == 0.0:
            return np.array([0.0, 0.0]), 0.0
        return vec / n, n

    # -----------------------------
    # Residual function F(v)
    # -----------------------------
    def F(v):
        r, T = unpack_vars(v)

        e = []
        Lk = []
        for k in range(N):
            ek, lk = unit(r[k + 1] - r[k])
            e.append(ek)
            Lk.append(lk)

        c_len = [Lk[k] - s for k in range(N)]

        c_fb = []
        for j in range(1, N):
            fb = T[j - 1] * e[j - 1] - T[j] * e[j] + np.array([0.0, -W])
            c_fb.extend([fb[0], fb[1]])

        return np.array(c_len + c_fb, dtype=float)

    # -----------------------------
    # Initial guess
    # -----------------------------
    def initial_guess():
        x_lin = np.linspace(A[0], B[0], N + 1)
        y_lin = np.linspace(A[1], B[1], N + 1)

        sag = 0.1 * L
        x_int = x_lin[1:-1]
        y_lin[1:-1] -= sag * ((x_int - A[0]) * (B[0] - x_int)) / (0.25 * L * L + 1e-12)

        coords = []
        for k in range(1, N):
            coords.extend([x_lin[k], y_lin[k]])

        T0 = [1.0] * N
        return np.array(coords + T0, dtype=float)

    # -----------------------------
    # Solve + time it
    # -----------------------------
    x0 = initial_guess()

    num_runs = 3
    times = []

    for _ in range(num_runs):
        start_time = time.perf_counter()
        sol, info = newton_solve(F, x0, J=None, tol=1e-10, max_iter=200, damping=False)
        end_time = time.perf_counter()
        times.append(end_time - start_time)

    avg_runtime = sum(times) / num_runs

    runtime_results.append(avg_runtime)
    iteration_results.append(info["iterations"])
    residual_results.append(info["residual"])

    print(f"N = {N}")
    print(f"  Success    : {info['success']}")
    print(f"  Iterations : {info['iterations']}")
    print(f"  Residual   : {info['residual']:.3e}")
    print(f"  Runtime    : {avg_runtime:.6f} s")

# -----------------------------
# Plot runtime vs N
# -----------------------------
plt.figure()
plt.plot(N_values, runtime_results, marker='o')
plt.grid(True)
plt.xlabel("Number of Links, N")
plt.ylabel("Average Runtime (s)")
plt.title("Runtime vs Number of Links")
plt.show()

# -----------------------------
# Print simple results table
# -----------------------------
print("\nSummary:")
print("N\tIterations\tResidual\t\tRuntime (s)")
for N, it, res, rt in zip(N_values, iteration_results, residual_results, runtime_results):
    print(f"{N}\t{it}\t\t{res:.3e}\t{rt:.6f}")